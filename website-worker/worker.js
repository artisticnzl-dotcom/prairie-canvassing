var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// appointment-calendar.mjs
var centralDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
var hour = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
var DAY = 864e5;
var FIRST_SERVICE_DATE = "2026-11-20";
var AFTERNOON = [14, 16, 18];
var ALL_DAY = [8, 10, 12, ...AFTERNOON];
function bookingBounds(now = /* @__PURE__ */ new Date()) {
  const today = (/* @__PURE__ */ new Date(`${centralDate.format(now)}T00:00:00Z`)).getTime();
  return { first: [isoDate(today + DAY), FIRST_SERVICE_DATE].sort()[1], last: isoDate(today + 90 * DAY) };
}
__name(bookingBounds, "bookingBounds");
function timeWindow(start) {
  const label = /* @__PURE__ */ __name((value) => hour.format(new Date(Date.UTC(2026, 0, 1, value))), "label");
  return `${label(start)}\u2013${label(start + 2)}`;
}
__name(timeWindow, "timeWindow");
function availableHours(date, bounds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < bounds.first || date > bounds.last) return [];
  const day = /* @__PURE__ */ new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || isoDate(day) !== date || isHoliday(day)) return [];
  switch (day.getUTCDay()) {
    case 1:
      return [2, 4, 5].includes(Math.ceil(day.getUTCDate() / 7)) ? AFTERNOON : [];
    case 2:
    case 5:
      return ALL_DAY;
    case 3:
      return day.getUTCMonth() >= 4 && day.getUTCMonth() <= 7 ? ALL_DAY : [];
    case 4:
      return AFTERNOON;
    default:
      return [];
  }
}
__name(availableHours, "availableHours");
function monthSlots(month, bounds, reserved) {
  const start = /* @__PURE__ */ new Date(`${month}-01T00:00:00Z`);
  const days = {};
  for (let date = start.getTime(); isoDate(date).startsWith(month); date += DAY) {
    const day = isoDate(date);
    const slots = availableHours(day, bounds).filter((startHour) => !reserved.has(`${day}/${startHour}`)).map((startHour) => ({ startHour, label: timeWindow(startHour) }));
    if (slots.length) days[day] = slots;
  }
  return days;
}
__name(monthSlots, "monthSlots");
function isoDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}
__name(isoDate, "isoDate");
function isHoliday(day) {
  const year = day.getUTCFullYear();
  const date = day.getTime();
  const weekday = day.getUTCDay();
  const month = day.getUTCMonth();
  const ordinal = Math.ceil(day.getUTCDate() / 7);
  const mondayHoliday = weekday === 1 && (month === 0 && ordinal === 3 || month === 1 && ordinal === 3 || month === 4 && new Date(date + 7 * DAY).getUTCMonth() !== month || month === 8 && ordinal === 1 || month === 9 && ordinal === 2);
  if (mondayHoliday || month === 10 && weekday === 4 && ordinal === 4) return true;
  const fixed = [
    Date.UTC(year, 0, 1),
    Date.UTC(year, 5, 19),
    Date.UTC(year, 6, 4),
    Date.UTC(year, 10, 11),
    Date.UTC(year, 11, 25),
    Date.UTC(year + 1, 0, 1)
  ];
  return fixed.some((holiday) => {
    const dow = new Date(holiday).getUTCDay();
    const observed = holiday + (dow === 6 ? -DAY : dow === 0 ? DAY : 0);
    return date === holiday || date === observed;
  });
}
__name(isHoliday, "isHoliday");

// booking-delivery.mjs
var BUSINESS_TIME_ZONE = "America/Chicago";
var preferredDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "short",
  day: "numeric",
  year: "numeric"
});
async function deliverBooking(booking, env) {
  const request = { action: "reserve", id: booking.requestId, receivedAt: (/* @__PURE__ */ new Date()).toISOString(), booking };
  const reservation = await callScheduling(request, env);
  if (reservation.ok !== true) return reservation;
  try {
    await env.BOOKING_EMAIL.send(makeEmail(request, env, reservation.customerEmailSent !== true));
  } catch (error) {
    console.error("Booking notification failed", request.id, error?.code ?? "unknown");
  }
  return reservation;
}
__name(deliverBooking, "deliverBooking");
async function callScheduling(request, env) {
  const endpoint = new URL(env.BOOKING_SHEET_WEBHOOK);
  if (endpoint.origin !== "https://script.google.com" || !/^\/macros\/s\/[\w-]+\/exec$/.test(endpoint.pathname)) {
    throw new Error("Invalid scheduling sheet endpoint");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BOOKING_SHEET_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const payload = JSON.stringify(request);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  const body = JSON.stringify({ payload, signature: Array.from(signature, (b) => b.toString(16).padStart(2, "0")).join("") });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(1e4)
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Scheduling sheet did not acknowledge the request");
      }
      const result = await response.json();
      if (typeof result.ok !== "boolean" || result.id !== request.id) {
        throw new Error("Scheduling sheet rejected the request");
      }
      return result;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}
__name(callScheduling, "callScheduling");
function makeEmail({ id, receivedAt, booking }, env, customerEmailFailed) {
  const address = [
    booking.streetAddress,
    booking.unit ? `Unit ${booking.unit}` : "",
    `${booking.city}, KS ${booking.zip}`
  ].filter(Boolean).join(", ");
  const date = preferredDateFormat.format(/* @__PURE__ */ new Date(`${booking.date}T00:00:00Z`));
  const received = new Date(receivedAt).toLocaleString("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short"
  });
  const phoneDigits = booking.phone.replace(/\D/g, "");
  const tel = `+${phoneDigits.length === 10 ? "1" : ""}${phoneDigits}`;
  const sheetUrl = env.BOOKING_SHEET_URL || "";
  const sheetNotice = customerEmailFailed ? "The automatic email to the customer did not send. Contact the customer directly." : "";
  const window = `${timeWindow(Number(booking.startHour))} Central`;
  const contact = ({text:"Text message",call:"Phone call",email:"Email"})[booking.contactMethod];
  const followUp = `Use the customer\u2019s preferred contact method to confirm the requested time.`;
  const lines = [
    ["Customer", booking.fullName, escapeHtml(booking.fullName)],
    ["Phone", booking.phone, `<a href="tel:${tel}" style="color:#22576d">${escapeHtml(booking.phone)}</a>`],
    ["Email", booking.email, booking.email ? `<a href="mailto:${encodeURIComponent(booking.email)}" style="color:#22576d">${escapeHtml(booking.email)}</a>` : ""],
    ["Service address", address, escapeHtml(address)],
    ["Requested date", date, escapeHtml(date)],
    ["Requested time", window, escapeHtml(window)],
    ["Preferred contact", contact, contact],
    ["Technician visited before booking", booking.technicianVisit === "yes" ? "Yes" : "No", booking.technicianVisit === "yes" ? "Yes" : "No"],
    ["Preferred time of day", booking.preferredTime, escapeHtml(booking.preferredTime)],
    ["Service requested", booking.type, escapeHtml(booking.type)]
  ].filter(([, value]) => value);
  const text = [
    "New dryer vent cleaning request",
    followUp,
    ...sheetNotice ? ["", sheetNotice] : [],
    "",
    ...lines.map(([label, value]) => `${label}: ${value}`),
    ...booking.notes ? ["", "Customer notes", booking.notes] : [],
    "",
    `Received: ${received} Central`,
    `Request ID: ${id}`,
    ...sheetUrl ? ["", `Scheduling sheet: ${sheetUrl}`] : []
  ].join("\n");
  const html = `<div style="background:#f3f6f5;padding:8px;font-family:Arial,sans-serif;color:#17302b">
    <div style="max-width:570px;margin:0 auto;background:#fff;border:1px solid #dce6e1;border-radius:12px">
      <div style="background:#153d35;color:#fff;padding:16px">
        <p style="margin:0 0 6px;font-size:13px;font-weight:bold">Prairie Lint Patrol</p>
        <h1 style="margin:0;font-size:22px;line-height:1.25">New service request</h1>
      </div>
      <div style="padding:16px">
        <p style="margin:0 0 16px;line-height:1.5">${followUp}</p>
        ${sheetNotice ? `<p style="padding:10px;background:#fff3de;line-height:1.5">${sheetNotice}</p>` : ""}
        ${lines.map(([label, , value]) => `<div style="border-bottom:1px solid #e7eeea;padding:9px 0">
          <p style="margin:0 0 3px;font-size:13px;line-height:1.35;font-weight:bold">${label}</p>
          <p style="margin:0;font-size:16px;line-height:1.45;word-wrap:break-word;overflow-wrap:anywhere">${value}</p>
        </div>`).join("")}
        ${booking.notes ? `<p style="margin:17px 0 4px;font-weight:bold">Customer notes</p>
          <p style="margin:0 0 14px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere">${escapeHtml(booking.notes).replace(/\r?\n/g, "<br>")}</p>` : ""}
        ${sheetUrl ? `<p style="margin:18px 0 0"><a href="${escapeHtml(sheetUrl)}" style="display:inline-block;padding:10px 15px;background:#153d35;border-radius:7px;color:#fff;text-decoration:none;font-weight:bold">Open scheduling sheet</a></p>` : ""}
        <p style="margin:16px 0 0;color:#50655f;font-size:12px;line-height:1.5">
          Received ${escapeHtml(received)} Central<br>Request ID: ${id}
        </p>
      </div>
    </div>
  </div>`;
  return {
    from: env.BOOKING_FROM,
    to: env.BOOKING_TO,
    subject: `New dryer vent request: ${booking.fullName.replace(/[\x00-\x1f\x7f]+/g, " ").trim()}`,
    text,
    html,
    ...booking.email && { replyTo: booking.email }
  };
}
__name(makeEmail, "makeEmail");
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
__name(escapeHtml, "escapeHtml");

// worker.mjs
var SITE_HOST = "prairielintpatrol.com";
var BODY_LIMIT = 32768;
var UNAVAILABLE = "We couldn't send your request right now. Please try again in a few minutes.";
var REQUEST_FIELDS = [
  ["fullName", "Full name", 100, true],
  ["phone", "Phone number", 35, true],
  ["email", "Email address", 254, true],
  ["contactMethod", "Preferred contact method", 5, true],
  ["technicianVisit", "Prior technician visit", 3, true],
  ["preferredTime", "Preferred time of day", 9, true],
  ["streetAddress", "Service street address", 200, true],
  ["unit", "Apartment or unit", 40],
  ["city", "City", 80, true],
  ["zip", "ZIP code", 10, true],
  ["date", "Appointment date", 10, true],
  ["startHour", "Appointment time", 2, true],
  ["requestId", "Request identifier", 32, true],
  ["type", "Service", 80, true],
  ["notes", "Notes", 1500]
];
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isWww = url.hostname === `www.${SITE_HOST}`;
    const isPublicHost = url.hostname === SITE_HOST || isWww;
    const isPageRequest = request.method === "GET" || request.method === "HEAD";
    if (isPublicHost && url.protocol === "http:") {
      url.protocol = "https:";
      if (isPageRequest) url.hostname = SITE_HOST;
      return Response.redirect(url, 308);
    }
    if (isWww && isPageRequest) {
      url.hostname = SITE_HOST;
      return Response.redirect(url, 308);
    }
    if (url.pathname === "/api/availability") return handleAvailability(request, env);
    if (url.pathname !== "/api/booking") {
      const response = await env.ASSETS.fetch(request);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")
          && response.headers.get("Content-Type")?.includes("text/html")) {
        const rewritten = new HTMLRewriter()
          .on("head", { element(element) { element.append("<style>.customer-review{max-width:900px;margin:28px 0 0;padding:clamp(24px,4vw,40px);border:1px solid #d5e1e7;border-radius:20px;background:#fff;color:#102d40;box-shadow:0 8px 30px #102d4008}.customer-review-top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}.customer-review-stars{color:#a96000;font-size:1.55rem;letter-spacing:3px;line-height:1.2}.customer-review-source,.customer-review-label{font-size:.9rem;color:#546775}.customer-review blockquote{margin:0}.customer-review blockquote p{font-size:1.05rem;line-height:1.8;margin:0}.customer-review figcaption{display:flex;align-items:center;gap:12px;margin-top:24px;font-size:1rem}.customer-review-avatar{display:grid;place-items:center;flex-shrink:0;width:44px;height:44px;border-radius:50%;background:#e7eff4;color:#102d40;font-weight:800;font-size:1.15rem}.customer-review-label{display:block;margin-top:3px}@media(max-width:600px){.customer-review{padding:24px 20px}.customer-review blockquote p{font-size:1rem}}</style>", { html: true }); } })
          .on("#reviews", { element(element) { element.setInnerContent("<div class=\"container\"><div class=\"intro\"><h2>Customer reviews</h2></div><figure class=\"customer-review\"><div class=\"customer-review-top\"><span class=\"customer-review-stars\" role=\"img\" aria-label=\"5 out of 5 stars\">\u2605\u2605\u2605\u2605\u2605</span><span class=\"customer-review-source\">Google review</span></div><blockquote><p>Zach did a great job! He not only cleaned my 30ft dryer vent tube, but he also checked the volume of air blowing through and used a camera to make sure it was clean. He was careful not to damage anything and made sure everything was put back in position when he was finished. He also took the time to clean my dryer and used the camera to inspect the inside of it as well. Zach was very friendly and pleasant to work with. I would definitely recommend Prairie Lint Patrol for this service and Zach! Thank you Zach!</p></blockquote><figcaption><span class=\"customer-review-avatar\" aria-hidden=\"true\">J</span><span><strong>John Lambert</strong><span class=\"customer-review-label\">Customer review</span></span></figcaption></figure></div>", { html: true }); } })
          .on("head", { element(element) { element.append("<style>.closure-notice{background:#fff2e5;color:#102d40;border-bottom:1px solid #edc6a1;padding:20px 0}.closure-notice h2{font-family:inherit;font-size:clamp(1.1rem,2vw,1.4rem);line-height:1.35;margin:0 0 8px;font-weight:800;letter-spacing:0}.closure-notice p{max-width:1000px;font-size:1rem;line-height:1.65;margin:0}.closure-notice a{color:inherit;font-weight:700;text-decoration:underline;text-underline-offset:3px}@media(max-width:600px){.closure-notice{padding:16px 0}.closure-notice p{font-size:.94rem}}</style>", { html: true }); } })
          .on("header", { element(element) { element.after("<aside class=\"closure-notice\" aria-labelledby=\"closure-notice-title\">\n  <div class=\"container\">\n    <h2 id=\"closure-notice-title\">Upcoming closure · December 14, 2026–January 27, 2027</h2>\n    <p>We’ll be out of the country visiting and assisting family in Mexico December 15–January 26. We return January 26, 2027, and appointments resume January 28. You can still <a href=\"#book\">schedule an appointment on our calendar</a> for the available days.</p>\n  </div>\n</aside>", { html: true }); } })
          .transform(response);
        return updateWebsiteCopy(addSiteSeal(rewritten));
      }
      if (request.method === "GET" && response.headers.get("Content-Type")?.includes("text/html")) {
        return updateWebsiteCopy(addSiteSeal(response));
      }
      return response;
    }
    return handleBooking(request, env, url);
  }
};
function addSiteSeal(response) {
  const updated = new HTMLRewriter()
    .on("footer", { element(element) { element.append("<div class=\"site-seal\" aria-label=\"Site security seal\" style=\"display:flex;justify-content:center;align-items:center;margin-top:24px;padding:0 20px 8px\"><div style=\"display:inline-block;background:#fff;padding:8px 12px;border-radius:6px\"><script type='text/javascript' src='https://rapidscansecure.com/siteseal/siteseal.js?code=65,04D7FD2C2D2F8DB14081A655DE68EA09796D6D30'></script></div></div>", { html: true }); } })
    .transform(response);
  updated.headers.delete("ETag");
  updated.headers.set("Cache-Control", "no-cache");
  return updated;
}
async function handleAvailability(request, env) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
  const bounds = bookingBounds();
  try {
    const { success } = await env.BOOKING_RATE_LIMIT.limit({ key: `calendar:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` });
    if (!success) return Response.json({ ok: false }, { status: 429, headers });
    const id = crypto.randomUUID().replaceAll("-", "");
    const result = await callScheduling({ action: "availability", id, receivedAt: (/* @__PURE__ */ new Date()).toISOString(), ...bounds }, env);
    if (!result.ok || result.calendarVersion !== 1 || !Array.isArray(result.reserved)) throw new Error("Calendar webhook is unavailable");
    const reserved = new Set(result.reserved);
    const months = [];
    const month = /* @__PURE__ */ new Date(`${bounds.first.slice(0, 7)}-01T00:00:00Z`);
    while (month.toISOString().slice(0, 7) <= bounds.last.slice(0, 7)) {
      months.push(month.toISOString().slice(0, 7));
      month.setUTCMonth(month.getUTCMonth() + 1);
    }
    const days = Object.assign({}, ...months.map((month2) => monthSlots(month2, bounds, reserved)));
    return Response.json({ ok: true, first: bounds.first, months, days }, { headers });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
__name(handleAvailability, "handleAvailability");
async function handleBooking(request, env, url) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const origin = request.headers.get("Origin");
  if (origin !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return bookingResponse(request, 403, "Open the Prairie Lint Patrol website and send your request from there.");
  }
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return bookingResponse(request, 415, "Please send your request through the booking form.");
  }
  let form;
  try {
    form = await readForm(request);
  } catch {
    return bookingResponse(request, 400, "We couldn't read your request. Please check the form and try again.");
  }
  if (!form) {
    return bookingResponse(request, 413, "The request is too long. Please shorten your notes and try again.");
  }
  if (form.get("bot-field")) {
    return bookingResponse(request, 200);
  }
  const booking = {};
  for (const [key, label, max, required] of REQUEST_FIELDS) {
    const value = form.get(key)?.trim() ?? "";
    if (required && !value) return bookingResponse(request, 422, `Please enter a value for ${label.toLowerCase()}.`);
    if (value.length > max) return bookingResponse(request, 422, `Please shorten the ${label.toLowerCase()} field.`);
    booking[key] = value;
  }
  const validationError = validateBooking(booking);
  if (validationError) return bookingResponse(request, 422, validationError);
  if (!env.BOOKING_EMAIL || !env.BOOKING_RATE_LIMIT || !env.BOOKING_FROM || !env.BOOKING_TO) {
    console.error("Booking email or rate limit binding is missing.");
    return bookingResponse(request, 503, UNAVAILABLE);
  }
  let reservation;
  try {
    const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.BOOKING_RATE_LIMIT.limit({ key: clientIp });
    if (!success) {
      return bookingResponse(request, 429, "Too many requests were submitted. Please wait a minute and try again.");
    }
    reservation = await deliverBooking(booking, env);
    if (!reservation.ok) {
      return reservation.code === "slot_taken" ? bookingResponse(request, 409, "That time is no longer available. Please choose another time.") : bookingResponse(request, 503, UNAVAILABLE);
    }
  } catch (error) {
    console.error("Booking delivery failed", error?.code ?? "unknown");
    return bookingResponse(request, 503, UNAVAILABLE);
  }
  return bookingResponse(request, 200, "", reservation.customerEmailSent === true);
}
__name(handleBooking, "handleBooking");
async function readForm(request) {
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const bytes = new Uint8Array(BODY_LIMIT);
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return new URLSearchParams(new TextDecoder().decode(bytes.subarray(0, length)));
    if (length + value.byteLength > BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    bytes.set(value, length);
    length += value.byteLength;
  }
}
__name(readForm, "readForm");
function validateBooking(booking) {
  if (!["yes", "no"].includes(booking.technicianVisit)) return "Please tell us whether a technician stopped by before you booked.";
  if (!["any", "morning", "afternoon", "evening"].includes(booking.preferredTime)) return "Please choose a preferred time of day.";
  const phoneDigits = booking.phone.replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    return "Please enter a valid phone number.";
  }
  if (booking.email && !/^[^\s@<>,"\\]+@[^\s@<>,"\\]+\.[^\s@<>,"\\]+$/.test(booking.email)) {
    return "Please enter a valid email address.";
  }
  if (!/^\d{5}(?:-\d{4})?$/.test(booking.zip)) {
    return "Please enter a valid ZIP code.";
  }
  if (!/^[a-f0-9]{32}$/.test(booking.requestId) || !["call", "text", "email"].includes(booking.contactMethod)) {
    return "Please choose how you\u2019d like us to contact you.";
  }
  if (!/^\d{1,2}$/.test(booking.startHour) || !availableHours(booking.date, bookingBounds()).includes(Number(booking.startHour))) {
    return "Please choose an available date and time.";
  }
  return "";
}
__name(validateBooking, "validateBooking");
function bookingResponse(request, status, message = "", customerEmailSent = false) {
  const headers = { "Cache-Control": "no-store" };
  if (status === 429) headers["Retry-After"] = "60";
  if (request.headers.get("Accept")?.includes("application/json")) {
    return Response.json({ ok: status === 200, message, ...status === 200 && { customerEmailSent } }, { status, headers });
  }
  if (status === 200) {
    return new Response(null, { status: 303, headers: { ...headers, Location: customerEmailSent ? "/thanks" : "/thanks?email=pending" } });
  }
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Booking request | Prairie Lint Patrol</title><main><h1>We couldn't send your request</h1><p>${message}</p><p><a href="/#book">Return to the booking form</a></p></main></html>`,
    { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } }
  );
}
__name(bookingResponse, "bookingResponse");
export {
  worker_default as default
};


function updateWebsiteCopy(response) {
 const replacements = [["Standard service from $149.", "Standard cleaning $149; roof-exhaust cleaning $169."], ["Standard cleaning starts at $149", "Standard cleaning $149; roof-exhaust cleaning $169"], ["Standard service starting price", "Standard vent cleaning"], ["starting at $149", "$149 standard / $169 roof-exhaust"], ["from $149", "$149 standard / $169 roof-exhaust"], ["rotary brushing and vacuum equipment", "brushing and air tools"], ["brushes and vacuum methods", "brushing and air tools"]];
 const replaceCopy = value => replacements.reduce((s,[oldText,newText])=>s.split(oldText).join(newText),value);
 const output = new HTMLRewriter()
 .on('#book select[name="city"]', { element(el) { el.replace('<input id="city" name="city" type="text" autocomplete="address-level2" maxlength="80" placeholder="Enter your city" required>', { html: true }); } })
 .on("head", { element(el) { el.append("<style>.plp-payment-note{font-size:16px;line-height:1.65;margin-top:20px}.plp-hero-prices{font-weight:800;color:#ffb579!important;font-size:18px!important}.plp-review-disclosure{font-weight:700;color:#526473;margin-bottom:14px!important}.plp-review-actions{margin-top:24px}.plp-visit-options legend{margin-bottom:10px}.fields small{font-size:14px;line-height:1.5;color:#526473}.footer-contact{overflow-wrap:anywhere}.plp-updated-prices{grid-template-columns:repeat(3,minmax(0,1fr))}.plp-updated-prices .pricecard{padding:28px}.plp-updated-prices .price{font-size:52px}@media(max-width:1000px){.plp-updated-prices{grid-template-columns:1fr}}</style>", {html:true}); } })
 .on(".hero-intro", { element(el) { el.append("<p class=\"plp-hero-prices\">Standard vent cleaning: $149 &nbsp; | &nbsp; Roof-exhaust vent cleaning: $169</p>", {html:true}); } })
 .on(".stats .stat:first-child", { element(el) { el.setInnerContent("<strong>$149 / $169</strong><span>Standard / roof-exhaust cleaning</span>", {html:true}); } })
 .on("#services .service:first-child p", { element(el) { el.setInnerContent("Remove accumulated lint from safely accessible residential dryer exhaust ducts with suitable brushing and air tools.", {html:true}); } })
 .on("#process .step:nth-child(2) p", { element(el) { el.setInnerContent("We use suitable brushing and air tools to remove lint from the accessible exhaust duct.", {html:true}); } })
 .on("#process .step:nth-child(4) p", { element(el) { el.setInnerContent("We share what we found, discuss any remaining issues, provide a written report with photos, and perform an airflow comparison when feasible.", {html:true}); } })
 .on("#pricing", { element(el) { el.setInnerContent("<div class=\"container\"><div class=\"intro\"><div class=\"kicker\">Pricing</div><h2>Clear pricing. No surprises.</h2><p>Standard dryer vent cleaning is $149 and roof-exhaust dryer vent cleaning is $169 for a typical accessible vent. Complex jobs receive a custom quote.</p></div><div class=\"prices plp-updated-prices\"><article class=\"pricecard main\"><div class=\"pilltag\">STANDARD DRYER VENT CLEANING</div><div class=\"price\">$149 <span>/ cleaning</span></div><p>Cleans the dryer vent line from the dryer connection to the exterior wall termination, where accessible.</p><ul><li>Post-cleaning camera scope check</li><li>Airflow comparison when feasible</li><li>Written report with photos</li></ul><a class=\"btn\" href=\"#book\">Request this service</a></article><article class=\"pricecard main\"><div class=\"pilltag\">ROOF-EXHAUST DRYER VENT CLEANING</div><div class=\"price\">$169 <span>/ cleaning</span></div><p>Cleans a dryer vent line that exits through the roof, where accessible.</p><ul><li>Post-cleaning camera scope check</li><li>Airflow comparison when feasible</li><li>Written report with photos</li></ul><a class=\"btn\" href=\"#book\">Request this service</a></article><article class=\"pricecard\"><div class=\"pilltag\" style=\"color:#ffad6f\">COMPLEX JOBS &amp; MULTIPLE UNITS</div><div class=\"price\" style=\"font-size:40px\">Custom <span>quote</span></div><p>For very long runs, difficult access, and multiple units or properties.</p><ul><li>Written quote before service</li><li>Multiple-unit scheduling available</li><li>Camera inspection where safely accessible</li></ul><a class=\"btn light\" href=\"#book\">Request a quote</a></article></div><div class=\"fine\">Pricing may vary with access conditions. The price is written on your service agreement before any work starts. No extra work is done without your separate approval on a new signed agreement. Cleaning does not include installing, modifying, or repairing ductwork or gas appliances. Camera inspection cannot guarantee a completely lint-free system.</div><p class=\"plp-payment-note\">Payment is due when the work is completed. We accept check, card or ACH bank transfer. No interest or finance charges.</p></div>", {html:true}); } })
 .on("#faq .faq details:nth-child(5) p", { element(el) { el.setInnerContent("$149 standard and $169 roof-exhaust are the prices for a typical accessible vent. Very long runs, difficult access, and multiple units or properties receive a custom quote. Your total is confirmed in writing on your service agreement before work begins. Extra work requires your separate approval on a new signed agreement.", {html:true}); } })
 .on("#faq .faq", { element(el) { el.append("<details><summary><h3>When can I schedule service?</h3></summary><p>Call, text, email or book online to request a future appointment. We will follow up to confirm your date and arrival window. If the sale starts at your door, we schedule the work after the applicable cancellation period. We do not perform same-day cleaning.</p></details><details><summary><h3>What will I sign?</h3></summary><p>Every customer signs a written service agreement listing the services and total price before work starts. Any extra work needs your separate approval on a new signed agreement.</p></details><details><summary><h3>Can I cancel a door-to-door service agreement?</h3></summary><p>For a qualifying Kansas door-to-door sale, you may cancel without penalty or obligation until midnight of the third business day after the transaction date. You receive a completed agreement and two copies of the Notice of Cancellation with the deadline and instructions. Payments are refunded within 10 business days after we receive a valid cancellation notice. Saturdays generally count; Sundays and legal holidays do not. Booking online does not waive any cancellation rights.</p></details><details><summary><h3>When do I pay?</h3></summary><p>Payment is due when the work is completed. We accept check, card or ACH bank transfer. No interest or finance charges. No payment is collected through the booking form.</p></details>", {html:true}); } })
 .on("#book .bookingcopy .check:first-child", { element(el) { el.setInnerContent("Standard cleaning $149; roof-exhaust cleaning $169", {html:true}); } })
 .on("#book .fields", { element(el) { el.prepend("<fieldset class=\"field full contact-options plp-visit-options\"><legend>Did a Prairie Lint Patrol technician stop by your home before you booked? *</legend><label><input type=\"radio\" name=\"technicianVisit\" value=\"yes\" required> Yes</label><label><input type=\"radio\" name=\"technicianVisit\" value=\"no\" required> No</label></fieldset>" + (PLP_LIVE_ON ? "" : "<div class=\"field full\"><label for=\"preferredTime\">Preferred time of day</label><select id=\"preferredTime\" name=\"preferredTime\"><option value=\"any\">Any time</option><option value=\"morning\">Morning</option><option value=\"afternoon\">Afternoon</option><option value=\"evening\">Evening</option></select><small>Your selected appointment window is your requested time; this preference helps us arrange alternatives if needed.</small></div>") + "", {html:true}); } })
 .on("#book .contact-options:not(.plp-visit-options)", { element(el) { el.append("<label><input type=\"radio\" name=\"contactMethod\" value=\"email\" required> Email</label>", {html:true}); } })
 .on("#type", { element(el) { el.setInnerContent("<option>Standard dryer vent cleaning ($149)</option><option>Roof-exhaust dryer vent cleaning ($169)</option><option>Complex or long vent run (quote)</option><option>Multiple properties or units (quote)</option><option>Not sure</option>", {html:true}); } })
 .on("#reviews blockquote", { element(el) { el.prepend("<p class=\"plp-review-disclosure\">Disclosure: John Lambert is a relative of owner Zach Lambert.</p>", {html:true}); } })
 .on("#reviews .container", { element(el) { el.append("<div class=\"plp-review-actions\"><a class=\"btn\" href=\"https://g.page/r/CcnmULVFXxSkEBM/review\" target=\"_blank\" rel=\"noopener\">Leave us a Google review</a></div>", {html:true}); } })
 .on(".footer-contact", { element(el) { el.setInnerContent("<strong>Prairie Lint Patrol LLC</strong><br>Based in Hesston, KS<br><a href=\"tel:+16208691692\">Call 620-869-1692</a><br><a href=\"sms:+16208691692\">Text Prairie Lint Patrol</a><br><a href=\"mailto:prairielintpatrol@gmail.com\">prairielintpatrol@gmail.com</a>", {html:true}); } })
 .on(".copy .cta p:nth-of-type(1)", { element(el) { el.setInnerContent("Standard dryer vent cleaning is $149 and roof-exhaust dryer vent cleaning is $169 for a typical accessible vent. Both include a post-cleaning camera scope check, airflow comparison when feasible, and a written report with photos. Very long runs, difficult access, and multiple units or properties receive a custom quote. Your total is confirmed in writing before work begins. Extra work requires your separate approval on a new signed agreement.", {html:true}); } })
 .on(".hero .wrap", { element(el) { el.append("<p><strong>Standard cleaning: $149 | Roof-exhaust cleaning: $169</strong></p>", {html:true}); } })
 .on("footer .wrap", { element(el) { el.append("<p class=\"footer-contact plp-town-contact\"><strong>Prairie Lint Patrol LLC</strong><br>Based in Hesston, KS<br><a href=\"tel:+16208691692\">Call 620-869-1692</a><br><a href=\"sms:+16208691692\">Text Prairie Lint Patrol</a><br><a href=\"mailto:prairielintpatrol@gmail.com\">prairielintpatrol@gmail.com</a></p>", {html:true}); } })
 .on('meta[name="description"],meta[property="og:description"]',{element(el){const value=el.getAttribute('content');if(value)el.setAttribute('content',replaceCopy(value));}})
 .on('p,span,li,small,h1,h2,h3',{text(chunk){if(chunk.text)chunk.replace(replaceCopy(chunk.text));}})
 .transform(response);
 output.headers.delete('ETag'); output.headers.set('Cache-Control','no-cache');
 return output;
}


// PLP_TEST_ADAPTER_V11 - isolated test form; preserve legacy production handlers.
// Isolated test-only adapter. Production booking routes remain in the original Worker.
const API_URL = 'https://bhouipoucvprekksdbjd.supabase.co/rest/v1/rpc/';
const CENTRAL = 'America/Chicago';
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const MESSAGES = {
  cancel_period: 'Because a technician visited you first, the earliest appointment is after your 3-day cancellation period. Please pick a later date.',
  unauthorized: 'The test connection is not configured. Call or text 620-869-1692.',
  unavailable: 'That test window is unavailable. Refresh the calendar and select another window.',
  slot_taken: 'That test window was just taken. Refresh the calendar and select another window.',
  rate_limited: 'The test request limit was reached. Please wait before retrying.',
  idempotency_conflict: 'That request ID belongs to different details. Review the form before starting a new request.',
  invalid_request: 'Please check the highlighted field and try again.',
};
const FIELDS = {
  name: 'full name', phone: 'phone number', email: 'email address', contact_pref: 'contact preference',
  street: 'service address', city: 'city', zip: 'ZIP code', service: 'service', preferred_time: 'time-of-day preference',
  tech_visited_first: 'prior technician visit', referral: 'referral information', notes: 'notes', slot_id: 'appointment window',
  request_id: 'request identifier', api_version: 'test configuration', honeypot: 'form',
};
const SERVICE_NAMES = {
  'Standard dryer vent cleaning ($149)': 'standard',
  'Roof-exhaust dryer vent cleaning ($169)': 'roof_exhaust',
  'Complex or long vent run (quote)': 'complex',
  'Multiple properties or units (quote)': 'multi_unit',
  'Not sure': 'not_sure',
};
function testBounds(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: CENTRAL, year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
  const t = new Date(today + 'T00:00:00Z');
  return { first: iso(t.getTime() + 86400000), last: iso(t.getTime() + 90 * 86400000) };
}
function iso(value) { return new Date(value).toISOString().slice(0, 10); }
function json(data, status = 200) { return Response.json(data, { status, headers: HEADERS }); }
function error(code, status = 503, field) {
  const message = code === 'invalid_request' && FIELDS[field]
    ? `Please check your ${FIELDS[field]} and try again.`
    : MESSAGES[code] || 'The test connection could not confirm the result. Retry with the same details and request ID.';
  return json({ok:false, test:true, code, message, ...(FIELDS[field] ? {field} : {})}, status);
}
async function rpc(name, body, env, fetcher) {
  if (!env.PLP_BOOKING_KEY || !env.PLP_SUPABASE_PUBLISHABLE_KEY) throw new Error('configuration');
  const response = await fetcher(API_URL + name, {
    method:'POST', headers: {apikey:env.PLP_SUPABASE_PUBLISHABLE_KEY, 'Content-Type':'application/json'},
    body: JSON.stringify({...body, p_client_key:env.PLP_BOOKING_KEY}), signal:AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('transport');
  const data = await response.json();
  if (!data || typeof data.ok !== 'boolean') throw new Error('schema');
  return data;
}
function normalizeSlot(slot, expectedDate) {
  if (!slot || typeof slot.slot_id !== 'string' || slot.slot_id.length > 100 || slot.date !== expectedDate
      || typeof slot.label !== 'string' || slot.label.length > 100 || slot.time_zone !== CENTRAL
      || !Number.isFinite(Date.parse(slot.starts_at)) || !Number.isFinite(Date.parse(slot.ends_at))) throw new Error('slot');
  return {slotId:slot.slot_id, label:slot.label, startsAt:slot.starts_at, endsAt:slot.ends_at};
}
async function testAvailability(request, env, fetcher = fetch) {
  if (request.method !== 'GET') return new Response(null, {status:405, headers:{...HEADERS, Allow:'GET'}});
  try {
    if (env.BOOKING_RATE_LIMIT) {
      const {success} = await env.BOOKING_RATE_LIMIT.limit({key:'test-calendar:' + (request.headers.get('CF-Connecting-IP') || 'unknown')});
      if (!success) return error('rate_limited',429);
    }
    const visited=new URL(request.url).searchParams.get('visited');
    if(!['yes','no'].includes(visited))return error('invalid_request',422,'tech_visited_first');
    const {first,last} = testBounds();
    const chunks=[];
    for (let from=first; from<=last;) {
      const to=iso(Math.min(Date.parse(from+'T00:00:00Z')+61*86400000,Date.parse(last+'T00:00:00Z')));
      chunks.push({p_from:from,p_to:to,p_tech_visited_first:visited});
      from=iso(Date.parse(to+'T00:00:00Z')+86400000);
    }
    const results = await Promise.all(chunks.map(body=>rpc('open_slots',body,env,fetcher)));
    const days={};let earliest=first;
    for(const result of results) {
      if (!result.ok) return error(result.error, result.error==='unauthorized'?503:422, result.field);
      if (result.api_version!=='1.1' || result.time_zone!==CENTRAL || !Array.isArray(result.days)) throw new Error('schema');
      if (/^\d{4}-\d{2}-\d{2}$/.test(result.earliest_date||'') && result.earliest_date>earliest) earliest=result.earliest_date;
      for(const day of result.days) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Array.isArray(day.slots)) throw new Error('day');
        if (day.date<first || day.date>last) continue;
        days[day.date]=day.closed===true?[]:day.slots.filter(s=>s.available===true).map(s=>normalizeSlot(s,day.date));
      }
    }
    const months=[];
    for(let d=new Date(first.slice(0,7)+'-01T00:00:00Z');iso(d)<=last;d.setUTCMonth(d.getUTCMonth()+1)) months.push(iso(d).slice(0,7));
    return json({ok:true,test:true,first:earliest,months,days,timeZone:CENTRAL,visited});
  } catch { return error('transport'); }
}
async function readLimited(request) {
  const reader=request.body?.getReader(); if(!reader)return new URLSearchParams();
  const chunks=[];let length=0;
  for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384){await reader.cancel();throw Error('body');}chunks.push(value);}
  const bytes=new Uint8Array(length);let i=0;for(const chunk of chunks){bytes.set(chunk,i);i+=chunk.length;}
  return new URLSearchParams(new TextDecoder().decode(bytes));
}
function mapForm(form, clientIp) {
  const get=k=>(form.get(k)||'').trim();
  return {
    p_api_version:'1.1',p_request_id:get('requestId'),p_slot_id:get('slotId'),
    p_name:get('fullName'),p_phone:get('phone'),p_email:get('email'),p_contact_pref:get('contactMethod'),
    p_street:get('streetAddress'),p_unit:get('unit'),p_city:get('city'),p_zip:get('zip'),
    p_service:SERVICE_NAMES[get('type')]||get('type'),p_preferred_time:'any',
    p_tech_visited_first:get('technicianVisit'),p_referred_by:get('referredBy'),p_referrer_phone:get('referrerPhone'),
    p_notes:get('notes'),p_honeypot:get('bot-field'),p_client_ip:clientIp,
  };
}
async function testBooking(request, env, fetcher = fetch) {
  if(request.method!=='POST')return new Response(null,{status:405,headers:{...HEADERS,Allow:'POST'}});
  const url=new URL(request.url);
  if(request.headers.get('Origin')!==url.origin || request.headers.get('Sec-Fetch-Site')==='cross-site') return error('origin',403);
  if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/x-www-form-urlencoded')return error('format',415);
  let data;
  try {
    const form=await readLimited(request);
    data=mapForm(form,request.headers.get('CF-Connecting-IP')||'');
    if(data.p_honeypot)return error('invalid_request',422,'honeypot');
    if(!/^[A-Za-z0-9_-]{8,80}$/.test(data.p_request_id))return error('invalid_request',422,'request_id');
    if(!data.p_slot_id || data.p_slot_id.length>100)return error('invalid_request',422,'slot_id');
    // Preserve future-only website policy until Zach confirms a different rule.
    // Never manufacture an opaque backend slot ID or a missing visit-history answer.
    if(!['yes','no'].includes(data.p_tech_visited_first))return error('invalid_request',422,'tech_visited_first');
  } catch {return error('invalid_request',413);}
  try {
    const result=await rpc('book_request',data,env,fetcher);
    if(!result.ok&&result.error==='unavailable'&&result.reason==='cancel_period')return error('cancel_period',409);
    if(!result.ok&&result.error==='unavailable'&&result.reason==='too_soon')return error('unavailable',409);
    if(!result.ok){const status=({slot_taken:409,unavailable:409,idempotency_conflict:409,rate_limited:429,invalid_request:422})[result.error]||503;return error(result.error,status,result.field);}
    if(result.test!==true || !/^[0-9a-f-]{36}$/i.test(result.booking_id) || !Number.isFinite(Date.parse(result.received_at)))throw Error('not-test');
    const slot=normalizeSlot(result.slot,result.slot.date);
    // TEST-only: no customer/business receipt, no Google Sheet write, no live-calendar reservation.
    return json({ok:true,test:true,bookingId:result.booking_id,receivedAt:result.received_at,replayed:result.replayed===true,
      status:result.status,slot,receipts:'suppressed',message:'TEST request saved. This is not a real appointment. No emails were sent.'});
  } catch {return error('transport');}
}
function testPage(response) {
  const rewritten=new HTMLRewriter()
    .on('head',{element(el){el.prepend('<meta name="robots" content="noindex,nofollow"><style>.plp-test-banner{padding:18px 28px;background:#fff2e5;color:#102d40;border-bottom:2px solid #f57d22;font:600 16px/1.5 Arial,sans-serif}.plp-test-result{white-space:pre-wrap;padding:16px;background:#eff4f6;border-radius:8px;font-size:16px}</style>',{html:true});}})
    .on('link[rel="canonical"]',{element(el){el.remove();}})
    .on('header',{element(el){el.after('<aside class="plp-test-banner"><strong>TEST BOOKING FORM</strong> - For Zach and the development team. Uses isolated TEST bookings. No real appointment or email will be created. <a href="/#book">Use the normal booking form</a>.</aside>',{html:true});}})
    .on('#requestForm',{element(el){el.setAttribute('action','/api/test/booking');el.append('<input type="hidden" name="slotId"><div class="field full"><label for="referredBy">Who referred you? (optional)</label><input id="referredBy" name="referredBy" maxlength="100"></div><div class="field full"><label for="referrerPhone">Referrer phone (optional)</label><input id="referrerPhone" name="referrerPhone" type="tel" maxlength="40"></div>',{html:true});}})
    .on('#requestForm input[name="email"]',{element(el){el.setAttribute('maxlength','200');}})
    .on('#requestForm input[name="streetAddress"]',{element(el){el.setAttribute('maxlength','150');}})
    .on('#requestForm textarea[name="notes"]',{element(el){el.setAttribute('maxlength','1000');}})
    .on('script[src="/assets/appointments.js"]',{element(el){el.setAttribute('src','/booking-test-app.js');}})
    .transform(response);
  rewritten.headers.set('Cache-Control','no-store');rewritten.headers.set('X-Robots-Tag','noindex, nofollow');
  rewritten.headers.delete('ETag');return rewritten;
}

const TEST_CLIENT_JS = "const form = document.getElementById('requestForm');\nconst calendar = document.getElementById('calendarDays');\nconst monthLabel = document.getElementById('calendarMonth');\nconst previousMonth = document.getElementById('previousMonth');\nconst nextMonth = document.getElementById('nextMonth');\nconst availabilityStatus = document.getElementById('availabilityStatus');\nconst retryCalendar = document.getElementById('retryCalendar');\nconst slotLabel = document.getElementById('slotDate');\nconst slotButtons = document.getElementById('slotButtons');\nconst selection = document.getElementById('selectedAppointment');\nconst submit = form.querySelector('button[type=\"submit\"]');\nconst status = document.getElementById('bookingStatus');\nconst fullDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' });\nconst monthFormat = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });\nconst toDate = date => new Date(`${date}T00:00:00Z`);\nlet months = [];\nlet days = {};\nlet monthIndex = 0;\nlet date = '';\nlet submitting = false;\n\nfunction renderMonth() {\n  const month = months[monthIndex];\n  const first = toDate(`${month}-01`);\n  monthLabel.textContent = monthFormat.format(first);\n  previousMonth.disabled = monthIndex === 0;\n  nextMonth.disabled = monthIndex === months.length - 1;\n  calendar.replaceChildren();\n  for (let index = 0; index < first.getUTCDay(); index++) calendar.append(document.createElement('span'));\n  for (let day = first; day.toISOString().startsWith(month); day.setUTCDate(day.getUTCDate() + 1)) {\n    const key = day.toISOString().slice(0, 10);\n    const button = document.createElement('button');\n    button.type = 'button';\n    button.dataset.date = key;\n    button.className = days[key]?.length ? 'calendar-day available' : 'calendar-day';\n    button.textContent = day.getUTCDate();\n    button.setAttribute('aria-label', `${fullDate.format(day)}, ${days[key]?.length ? 'appointments available' : 'no appointments available'}`);\n    button.setAttribute('aria-pressed', String(date === key));\n    calendar.append(button);\n  }\n}\n\nfunction selectDay(key, focus = false) {\n  date = key;\n  form.elements.date.value = '';\n  form.elements.startHour.value = '';\n  form.elements.slotId.value = '';\n  form.elements.requestId.value = '';\n  submit.disabled = true;\n  selection.hidden = true;\n  slotButtons.replaceChildren();\n  slotLabel.textContent = key ? fullDate.format(toDate(key)) : 'Choose a date';\n  if (key && !days[key]?.length) {\n    const message = document.createElement('p');\n    message.className = 'calendar-message';\n    message.textContent = 'No appointments available';\n    slotButtons.append(message);\n  }\n  for (const slot of days[key] ?? []) {\n    const button = document.createElement('button');\n    button.type = 'button';\n    button.className = 'slot-button';\n    button.textContent = slot.label;\n    button.setAttribute('aria-pressed', 'false');\n    button.addEventListener('click', () => {\n      if (submitting) return;\n      for (const option of slotButtons.querySelectorAll('button')) option.setAttribute('aria-pressed', String(option === button));\n      form.elements.date.value = key;\n      form.elements.startHour.value = 'test';\n      form.elements.slotId.value = slot.slotId;\n      form.elements.requestId.value = '';\n      selection.textContent = `${fullDate.format(toDate(key))} · ${slot.label} Central Time`;\n      selection.hidden = false;\n      status.hidden = true;\n      submit.disabled = false;\n    });\n    slotButtons.append(button);\n  }\n  renderMonth();\n  if (focus) calendar.querySelector(`[data-date=\"${key}\"]`)?.focus();\n}\n\nasync function testRequestId() {\n  const data = new URLSearchParams(new FormData(form));\n  data.delete('requestId');\n  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.toString()))), byte => byte.toString(16).padStart(2,'0')).join('');\n  const key='plp-test-last-request';\n  try {\n    const saved=JSON.parse(sessionStorage.getItem(key)||'null');\n    if(saved?.hash===hash && Date.now()-saved.created<86400000) return saved.id;\n  } catch {}\n  const id='web_test_'+crypto.randomUUID().replaceAll('-','');\n  try { sessionStorage.setItem(key,JSON.stringify({hash,id,created:Date.now()})); } catch {}\n  return id;\n}\n\nfunction visitAnswer() {\n  const f = form.elements.technicianVisit;\n  if (!f) return '';\n  if (f instanceof RadioNodeList || f.length) { for (const o of (f.length ? f : [f])) if (o.checked) return o.value; return f.value || ''; }\n  return f.value || '';\n}\nasync function loadAvailability(preferredDate = '') {\n  const visited = visitAnswer();\n  if (!['yes', 'no'].includes(visited)) {\n    calendar.replaceChildren(); slotButtons.replaceChildren(); submit.disabled = true; selection.hidden = true;\n    availabilityStatus.textContent = 'Answer “Did a Prairie Lint Patrol technician stop by your home before you booked?” to see open times.';\n    retryCalendar.hidden = true;\n    return;\n  }\n  availabilityStatus.textContent = 'Loading appointment times…';\n  retryCalendar.hidden = true;\n  try {\n    const response = await fetch('/api/test/availability?visited=' + visited, { cache: 'no-store' });\n    const data = await response.json();\n    if (!response.ok || !data.ok || !data.months.length) throw new Error('Unavailable');\n    months = data.months;\n    days = data.days;\n    const initialDate = preferredDate || Object.keys(days)[0] || `${months[0]}-01`;\n    monthIndex = Math.max(0, months.indexOf(initialDate.slice(0, 7)));\n    selectDay(initialDate);\n    const firstDate = toDate(data.first);\n    const start = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(firstDate);\n    availabilityStatus.textContent = `No appointments available before ${start}. All times are Central.`;\n  } catch {\n    calendar.replaceChildren();\n    slotButtons.replaceChildren();\n    previousMonth.disabled = true;\n    nextMonth.disabled = true;\n    submit.disabled = true;\n    selection.hidden = true;\n    availabilityStatus.textContent = 'Appointment times couldn’t load. Try again, or call or text 620-869-1692.';\n    retryCalendar.hidden = false;\n  }\n}\n\ncalendar.addEventListener('click', event => {\n  const day = event.target.closest('button[data-date]');\n  if (day && !submitting) selectDay(day.dataset.date, true);\n});\nfor (const [button, direction] of [[previousMonth, -1], [nextMonth, 1]]) {\n  button.addEventListener('click', () => {\n    if (submitting) return;\n    monthIndex += direction;\n    const month = months[monthIndex];\n    selectDay(Object.keys(days).find(key => key.startsWith(month)) || `${month}-01`);\n  });\n}\nretryCalendar.addEventListener('click', () => loadAvailability(date));\nform.addEventListener('input', () => { if (!submitting) form.elements.requestId.value = ''; });\nform.addEventListener('change', event => { if (event.target.name === 'technicianVisit' && !submitting) loadAvailability(); });\nform.addEventListener('submit', async event => {\n  event.preventDefault();\n  if (submitting || !form.elements.slotId.value) return;\n  submitting = true;\n  submit.disabled = true;\n  form.elements.requestId.value ||= await testRequestId();\n  status.hidden = false;\n  status.textContent = 'Sending your request…';\n  try {\n    const response = await fetch(form.action, {\n      method: 'POST', body: new URLSearchParams(new FormData(form)), headers: { Accept: 'application/json' },\n    });\n    const result = await response.json();\n    if (response.ok && result.ok) {\n      status.className = 'plp-test-result';\n      status.textContent = `${result.message}\\nBooking ID: ${result.bookingId}\\nReceived: ${result.receivedAt}\\nReplay: ${result.replayed ? 'yes' : 'no'}`;\n      submitting = false;\n      submit.disabled = false;\n      submit.textContent = 'Replay this TEST request';\n      return;\n    }\n    status.textContent = result.message || 'We couldn’t send your request. Please try again.';\n    if (response.status === 409 && ['slot_taken','unavailable','cancel_period'].includes(result.code)) await loadAvailability(date);\n  } catch {\n    status.textContent = 'The TEST result is not confirmed. Retry with the same details so the same request ID is used.';\n  }\n  submitting = false;\n  submit.disabled = !form.elements.slotId.value;\n});\n\nloadAvailability();\n";
const PLP_TEST_PUBLIC_KEY = "sb_publishable_T64NN7ipoQrgR3spNDG1Gw_fn9zT1x4";
const plpOriginalFetch = worker_default.fetch.bind(worker_default);
worker_default.fetch = async function(request, env, ctx) {
  const url = new URL(request.url);
  const testEnv = {...env, PLP_SUPABASE_PUBLISHABLE_KEY: PLP_TEST_PUBLIC_KEY};
  if(url.pathname === '/api/test/availability') return testAvailability(request,testEnv);
  if(url.pathname === '/api/test/booking') return testBooking(request,testEnv);
  if(url.pathname === '/booking-test-app.js') return new Response(TEST_CLIENT_JS,{headers:{...HEADERS,'Content-Type':'text/javascript; charset=utf-8'}});
  if(url.pathname === '/booking-test') {
    if(request.method!=='GET')return new Response(null,{status:405,headers:{Allow:'GET',...HEADERS}});
    const home = new URL('/',url.origin);
    const response = await plpOriginalFetch(new Request(home,request),env,ctx);
    if(!response.ok || !response.headers.get('Content-Type')?.includes('text/html'))return new Response('Test page unavailable',{status:503,headers:HEADERS});
    return testPage(response);
  }
  return plpOriginalFetch(request,env,ctx);
};

// PLP_LIVE_BOOKING_V1 - real website bookings go to the shared Supabase calendar (the app sees them),
// then a copy goes to the Google Sheet (which also emails the customer), then the business email.
// Without the PLP_BOOKING_LIVE_KEY secret, everything falls back to the original sheet-only handlers.
const LIVE_HEADERS = { 'Cache-Control': 'no-store' };
const LIVE_MESSAGES = {
  cancel_period: 'Because a technician visited you first, the earliest appointment is after your 3-day cancellation period. Please choose a later date.',
  unavailable: 'That time is no longer available. Please choose another time.',
  slot_taken: 'That time is no longer available. Please choose another time.',
  rate_limited: 'Too many requests were submitted. Please wait a minute and try again.',
  idempotency_conflict: 'Please review the form and send your request again.',
};
const LIVE_FIELDS = {
  name: 'full name', phone: 'phone number', email: 'email address', contact_pref: 'contact method',
  street: 'service address', city: 'city', zip: 'ZIP code', service: 'service', notes: 'notes',
  tech_visited_first: 'answer about a technician visit', slot_id: 'appointment time', unit: 'apartment or unit',
};
function liveSlotId(date, startHour) {
  const h = Number(startHour);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isInteger(h) || h < 0 || h > 22) return '';
  const p = n => String(n).padStart(2, '0');
  return `${date}_${p(h)}00-${p(h + 2)}00`;
}
async function liveRpc(name, body, env, fetcher) {
  const response = await fetcher('https://bhouipoucvprekksdbjd.supabase.co/rest/v1/rpc/' + name, {
    method: 'POST', headers: { apikey: env.PLP_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, p_client_key: env.PLP_BOOKING_LIVE_KEY }), signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('transport ' + response.status);
  const data = await response.json();
  if (!data || typeof data.ok !== 'boolean') throw new Error('schema');
  return data;
}
function bookingBoundsLive(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const t = Date.parse(today + 'T00:00:00Z');
  const d = x => new Date(x).toISOString().slice(0, 10);
  return { first: d(t + 86400000), last: d(t + 90 * 86400000) };
}
async function liveAvailability(request, env, fetcher = fetch) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...LIVE_HEADERS, Allow: 'GET' } });
  try {
    if (env.BOOKING_RATE_LIMIT) {
      const { success } = await env.BOOKING_RATE_LIMIT.limit({ key: 'calendar:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
      if (!success) return Response.json({ ok: false }, { status: 429, headers: LIVE_HEADERS });
    }
    const v = new URL(request.url).searchParams.get('visited');
    // Older pages ask without an answer: show next-day times; the booking itself still enforces the cancel period.
    const visited = ['yes', 'no'].includes(v) ? v : 'no';
    const { first, last } = bookingBoundsLive();
    const chunks = [];
    for (let from = first; from <= last;) {
      const to = new Date(Math.min(Date.parse(from + 'T00:00:00Z') + 61 * 86400000, Date.parse(last + 'T00:00:00Z'))).toISOString().slice(0, 10);
      chunks.push({ p_from: from, p_to: to, p_tech_visited_first: visited });
      from = new Date(Date.parse(to + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    }
    const results = await Promise.all(chunks.map(b => liveRpc('open_slots', b, env, fetcher)));
    const days = {}; let earliest = first;
    for (const r of results) {
      if (!r.ok || r.time_zone !== 'America/Chicago' || !Array.isArray(r.days)) throw new Error('calendar');
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.earliest_date || '') && r.earliest_date > earliest) earliest = r.earliest_date;
      for (const day of r.days) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || day.date < first || day.date > last || day.closed === true || !Array.isArray(day.slots)) continue;
        const slots = day.slots.filter(s => s.available === true && typeof s.slot_id === 'string' && /^\d{2}:00-\d{2}:00$/.test(s.window || ''))
          .map(s => ({ slotId: s.slot_id, startHour: Number(s.window.slice(0, 2)), label: String(s.label).replace(' – ', '–') }));
        if (slots.length) days[day.date] = slots;
      }
    }
    const months = [];
    for (let m = new Date(first.slice(0, 7) + '-01T00:00:00Z'); m.toISOString().slice(0, 7) <= last.slice(0, 7); m.setUTCMonth(m.getUTCMonth() + 1)) months.push(m.toISOString().slice(0, 7));
    return Response.json({ ok: true, first: earliest, months, days, timeZone: 'America/Chicago', visited }, { headers: LIVE_HEADERS });
  } catch (e) {
    console.error('Live calendar failed', String(e?.message || e));
    return Response.json({ ok: false }, { status: 503, headers: LIVE_HEADERS });
  }
}
const LIVE_SERVICE = {
  'Standard dryer vent cleaning ($149)': 'standard', 'Roof-exhaust dryer vent cleaning ($169)': 'roof_exhaust',
  'Complex or long vent run (quote)': 'complex', 'Multiple properties or units (quote)': 'multi_unit', 'Not sure': 'not_sure',
};
function liveReply(request, status, message = '', extra = {}) {
  const headers = { ...LIVE_HEADERS };
  if (status === 429) headers['Retry-After'] = '60';
  if (request.headers.get('Accept')?.includes('application/json')) return Response.json({ ok: status === 200, message, ...extra }, { status, headers });
  if (status === 200) return new Response(null, { status: 303, headers: { ...headers, Location: extra.customerEmailSent ? '/thanks' : '/thanks?email=pending' } });
  const safe = String(message).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Booking request | Prairie Lint Patrol</title><main><h1>We couldn't send your request</h1><p>${safe}</p><p><a href="/#book">Return to the booking form</a></p></main></html>`,
    { status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}
async function liveReadForm(request) {
  const reader = request.body?.getReader(); if (!reader) return new URLSearchParams();
  const chunks = []; let length = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 32768) { await reader.cancel(); return null; } chunks.push(value); }
  const bytes = new Uint8Array(length); let i = 0; for (const c of chunks) { bytes.set(c, i); i += c.length; }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}
// deps lets tests replace the sheet call and the email builder
async function liveBooking(request, env, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const sheet = deps.callScheduling || ((r, e) => callScheduling(r, e));
  const buildEmail = deps.makeEmail || ((r, e, f) => makeEmail(r, e, f));
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')
    return liveReply(request, 403, 'Open the Prairie Lint Patrol website and send your request from there.');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded')
    return liveReply(request, 415, 'Please send your request through the booking form.');
  let form;
  try { form = await liveReadForm(request); } catch { return liveReply(request, 400, "We couldn't read your request. Please check the form and try again."); }
  if (!form) return liveReply(request, 413, 'The request is too long. Please shorten your notes and try again.');
  if (form.get('bot-field')) return liveReply(request, 200, '', { customerEmailSent: true });
  const get = k => (form.get(k) || '').trim();
  const requestId = get('requestId');
  if (!/^[a-f0-9]{32}$/.test(requestId)) return liveReply(request, 422, 'Please refresh the page and send your request again.');
  if (!['yes', 'no'].includes(get('technicianVisit'))) return liveReply(request, 422, 'Please tell us whether a technician stopped by before you booked.');
  const slotId = get('slotId') || liveSlotId(get('date'), get('startHour'));
  if (!slotId || slotId.length > 40) return liveReply(request, 422, 'Please choose an available date and time.');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const { success } = await env.BOOKING_RATE_LIMIT.limit({ key: ip });
    if (!success) return liveReply(request, 429, LIVE_MESSAGES.rate_limited);
  } catch { /* rate limiter unavailable: the database also limits */ }
  let result;
  try {
    result = await liveRpc('book_request', {
      p_api_version: '1.1', p_request_id: requestId, p_slot_id: slotId,
      p_name: get('fullName'), p_phone: get('phone'), p_email: get('email'), p_contact_pref: get('contactMethod'),
      p_street: get('streetAddress'), p_unit: get('unit'), p_city: get('city'), p_zip: get('zip'),
      p_service: LIVE_SERVICE[get('type')] || get('type'), p_preferred_time: 'any',
      p_tech_visited_first: get('technicianVisit'), p_referred_by: get('referredBy'), p_referrer_phone: get('referrerPhone'),
      p_notes: get('notes'), p_honeypot: '', p_client_ip: ip,
    }, env, fetcher);
  } catch (e) {
    console.error('Live booking save failed', String(e?.message || e));
    return liveReply(request, 503, "We couldn't send your request right now. Please try again in a few minutes, or call or text 620-869-1692.");
  }
  if (!result.ok) {
    const code = result.error === 'unavailable' && result.reason === 'cancel_period' ? 'cancel_period' : result.error;
    const status = ({ slot_taken: 409, unavailable: 409, cancel_period: 409, idempotency_conflict: 409, rate_limited: 429, invalid_request: 422 })[code] || 503;
    const message = code === 'invalid_request' && LIVE_FIELDS[result.field] ? `Please check your ${LIVE_FIELDS[result.field]} and try again.`
      : LIVE_MESSAGES[code] || "We couldn't send your request right now. Please try again in a few minutes, or call or text 620-869-1692.";
    return liveReply(request, status, message, { code });
  }
  if (result.test === true) return liveReply(request, 503, "We couldn't send your request right now. Please call or text 620-869-1692.");
  const slot = result.slot || {};
  const done = result.delivery || {};
  const booking = {
    fullName: get('fullName'), phone: get('phone'), email: get('email'), contactMethod: get('contactMethod'),
    technicianVisit: get('technicianVisit'), preferredTime: '', streetAddress: get('streetAddress'), unit: get('unit'),
    city: get('city'), zip: get('zip'), date: slot.date, startHour: String(Number(String(slot.window || '').slice(0, 2))),
    requestId, type: get('type'),
    notes: [get('referredBy') ? `Referred by: ${get('referredBy')}${get('referrerPhone') ? ' (' + get('referrerPhone') + ')' : ''}` : '', get('notes')].filter(Boolean).join('\n'),
  };
  const delivery = {};
  let customerEmailSent = done.customer_email === 'sent';
  // 1. Copy to the Google Sheet (it emails the customer). The shared calendar already decided the slot.
  if (done.sheet !== 'ok') {
    try {
      const r = await sheet({ action: 'reserve', id: requestId, receivedAt: new Date().toISOString(), booking }, env);
      if (r.ok === true) { delivery.sheet = 'ok'; customerEmailSent = r.customerEmailSent === true; }
      else { delivery.sheet = r.code === 'slot_taken' ? 'slot_conflict' : 'failed'; delivery.last_error = 'sheet:' + String(r.code || 'rejected').slice(0, 40); }
    } catch (e) { delivery.sheet = 'failed'; delivery.last_error = 'sheet:' + String(e?.message || e).slice(0, 80); }
    delivery.customer_email = customerEmailSent ? 'sent' : 'not_sent';
  }
  // 2. Business email (once).
  if (done.business_email !== 'sent') {
    try {
      const email = buildEmail({ id: requestId, receivedAt: result.received_at || new Date().toISOString(), booking }, env, !customerEmailSent);
      const sheetState = delivery.sheet || done.sheet;
      const note = [`Saved in the Prairie app as an online booking (ID ${result.booking_id}). Open the app to confirm it.`,
        sheetState === 'ok' ? '' : sheetState === 'slot_conflict' ? 'The Google Sheet already had something in this window. The app calendar accepted it; check the sheet.' : 'This request was NOT copied to the Google Sheet. The app has it.'].filter(Boolean);
      email.text = note.join('\n') + '\n\n' + email.text;
      email.html = `<div style="font-family:Arial,sans-serif;padding:10px;background:#e8f2ff;color:#102d40;line-height:1.5">${note.join('<br>')}</div>` + email.html;
      await env.BOOKING_EMAIL.send(email);
      delivery.business_email = 'sent';
    } catch (e) { delivery.business_email = 'failed'; delivery.last_error = 'email:' + String(e?.message || e).slice(0, 80); }
  }
  if (Object.keys(delivery).length) {
    try { await liveRpc('booking_delivery', { p_booking_id: result.booking_id, p_delivery: delivery }, env, fetcher); }
    catch (e) { console.error('Delivery record failed', result.booking_id, String(e?.message || e)); }
  }
  return liveReply(request, 200, '', { customerEmailSent, bookingId: result.booking_id });
}

var PLP_LIVE_ON = false;
// Blog page (Soro): the homepage's header, footer and styles, with the blog in place of the main content.
async function plpBlog(request, env, ctx, url) {
  const home = await plpBeforeLive(new Request(url.origin + '/', { headers: request.headers }), env, ctx);
  if (!home.ok || !home.headers.get('Content-Type')?.includes('text/html')) return home;
  let replaced = false;
  const canonical = url.origin + url.pathname;
  const out = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent('Dryer Vent Safety Blog | Prairie Lint Patrol'); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute('content', 'Dryer vent cleaning tips, fire safety and maintenance advice from Prairie Lint Patrol in Hesston, Kansas.'); } })
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', canonical); } })
    .on('meta[property="og:url"]', { element(el) { el.setAttribute('content', canonical); } })
    .on('meta[property="og:title"]', { element(el) { el.setAttribute('content', 'Dryer Vent Safety Blog | Prairie Lint Patrol'); } })
    .on('script[type="application/ld+json"]', { element(el) { el.remove(); } })
    .on('a[href^="#"]', { element(el) { const h = el.getAttribute('href'); if (h.length > 1) el.setAttribute('href', '/' + h); } })
    .on('main', { element(el) { replaced = true; el.setInnerContent('<section class="plp-blog" style="max-width:960px;margin:0 auto;padding:32px 16px 56px"><div id="soro-blog"></div></section>', { html: true }); } })
    .on('body', { element(el) { el.append('<script src="https://app.trysoro.com/api/embed/b40979ba-699d-423b-bada-3731357aba47" defer></script>', { html: true }); } })
    .transform(home);
  const html = await out.text();
  if (!replaced) return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dryer Vent Safety Blog | Prairie Lint Patrol</title><link rel="canonical" href="' + canonical + '"><body><p><a href="/">Prairie Lint Patrol</a></p><div id="soro-blog"></div><script src="https://app.trysoro.com/api/embed/b40979ba-699d-423b-bada-3731357aba47" defer></script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
  const headers = new Headers(home.headers); headers.delete('ETag'); headers.delete('Content-Length'); headers.set('Cache-Control', 'no-cache');
  return new Response(html, { status: 200, headers });
}
const LIVE_CLIENT_JS = "const form = document.getElementById('requestForm');\nconst calendar = document.getElementById('calendarDays');\nconst monthLabel = document.getElementById('calendarMonth');\nconst previousMonth = document.getElementById('previousMonth');\nconst nextMonth = document.getElementById('nextMonth');\nconst availabilityStatus = document.getElementById('availabilityStatus');\nconst retryCalendar = document.getElementById('retryCalendar');\nconst slotLabel = document.getElementById('slotDate');\nconst slotButtons = document.getElementById('slotButtons');\nconst selection = document.getElementById('selectedAppointment');\nconst submit = form.querySelector('button[type=\"submit\"]');\nconst status = document.getElementById('bookingStatus');\nconst fullDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' });\nconst monthFormat = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });\nconst toDate = date => new Date(`${date}T00:00:00Z`);\nlet months = [];\nlet days = {};\nlet monthIndex = 0;\nlet date = '';\nlet submitting = false;\n\nfunction renderMonth() {\n  const month = months[monthIndex];\n  const first = toDate(`${month}-01`);\n  monthLabel.textContent = monthFormat.format(first);\n  previousMonth.disabled = monthIndex === 0;\n  nextMonth.disabled = monthIndex === months.length - 1;\n  calendar.replaceChildren();\n  for (let index = 0; index < first.getUTCDay(); index++) calendar.append(document.createElement('span'));\n  for (let day = first; day.toISOString().startsWith(month); day.setUTCDate(day.getUTCDate() + 1)) {\n    const key = day.toISOString().slice(0, 10);\n    const button = document.createElement('button');\n    button.type = 'button';\n    button.dataset.date = key;\n    button.className = days[key]?.length ? 'calendar-day available' : 'calendar-day';\n    button.textContent = day.getUTCDate();\n    button.setAttribute('aria-label', `${fullDate.format(day)}, ${days[key]?.length ? 'appointments available' : 'no appointments available'}`);\n    button.setAttribute('aria-pressed', String(date === key));\n    calendar.append(button);\n  }\n}\n\nfunction selectDay(key, focus = false) {\n  date = key;\n  form.elements.date.value = '';\n  form.elements.startHour.value = '';\n  form.elements.slotId.value = '';\n  form.elements.requestId.value = '';\n  submit.disabled = true;\n  selection.hidden = true;\n  slotButtons.replaceChildren();\n  slotLabel.textContent = key ? fullDate.format(toDate(key)) : 'Choose a date';\n  if (key && !days[key]?.length) {\n    const message = document.createElement('p');\n    message.className = 'calendar-message';\n    message.textContent = 'No appointments available';\n    slotButtons.append(message);\n  }\n  for (const slot of days[key] ?? []) {\n    const button = document.createElement('button');\n    button.type = 'button';\n    button.className = 'slot-button';\n    button.textContent = slot.label;\n    button.setAttribute('aria-pressed', 'false');\n    button.addEventListener('click', () => {\n      if (submitting) return;\n      for (const option of slotButtons.querySelectorAll('button')) option.setAttribute('aria-pressed', String(option === button));\n      form.elements.date.value = key;\n      form.elements.startHour.value = String(slot.startHour);\n      form.elements.slotId.value = slot.slotId;\n      form.elements.requestId.value = '';\n      selection.textContent = `${fullDate.format(toDate(key))} · ${slot.label} Central Time`;\n      selection.hidden = false;\n      status.hidden = true;\n      submit.disabled = false;\n    });\n    slotButtons.append(button);\n  }\n  renderMonth();\n  if (focus) calendar.querySelector(`[data-date=\"${key}\"]`)?.focus();\n}\n\nasync function liveRequestId() {\n  const data = new URLSearchParams(new FormData(form));\n  data.delete('requestId');\n  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.toString()))), byte => byte.toString(16).padStart(2,'0')).join('');\n  const key='plp-last-request';\n  try {\n    const saved=JSON.parse(sessionStorage.getItem(key)||'null');\n    if(saved?.hash===hash && Date.now()-saved.created<86400000) return saved.id;\n  } catch {}\n  const id=crypto.randomUUID().replaceAll('-','');\n  try { sessionStorage.setItem(key,JSON.stringify({hash,id,created:Date.now()})); } catch {}\n  return id;\n}\n\nfunction visitAnswer() {\n  const f = form.elements.technicianVisit;\n  if (!f) return '';\n  if (f instanceof RadioNodeList || f.length) { for (const o of (f.length ? f : [f])) if (o.checked) return o.value; return f.value || ''; }\n  return f.value || '';\n}\nasync function loadAvailability(preferredDate = '') {\n  const visited = visitAnswer();\n  if (!['yes', 'no'].includes(visited)) {\n    calendar.replaceChildren(); slotButtons.replaceChildren(); submit.disabled = true; selection.hidden = true;\n    availabilityStatus.textContent = 'Answer “Did a Prairie Lint Patrol technician stop by your home before you booked?” to see open times.';\n    retryCalendar.hidden = true;\n    return;\n  }\n  availabilityStatus.textContent = 'Loading appointment times…';\n  retryCalendar.hidden = true;\n  try {\n    const response = await fetch('/api/availability?visited=' + visited, { cache: 'no-store' });\n    const data = await response.json();\n    if (!response.ok || !data.ok || !data.months.length) throw new Error('Unavailable');\n    months = data.months;\n    days = data.days;\n    const initialDate = preferredDate || Object.keys(days)[0] || `${months[0]}-01`;\n    monthIndex = Math.max(0, months.indexOf(initialDate.slice(0, 7)));\n    selectDay(initialDate);\n    const firstDate = toDate(data.first);\n    const start = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(firstDate);\n    availabilityStatus.textContent = `No appointments available before ${start}. All times are Central.`;\n  } catch {\n    calendar.replaceChildren();\n    slotButtons.replaceChildren();\n    previousMonth.disabled = true;\n    nextMonth.disabled = true;\n    submit.disabled = true;\n    selection.hidden = true;\n    availabilityStatus.textContent = 'Appointment times couldn’t load. Try again, or call or text 620-869-1692.';\n    retryCalendar.hidden = false;\n  }\n}\n\ncalendar.addEventListener('click', event => {\n  const day = event.target.closest('button[data-date]');\n  if (day && !submitting) selectDay(day.dataset.date, true);\n});\nfor (const [button, direction] of [[previousMonth, -1], [nextMonth, 1]]) {\n  button.addEventListener('click', () => {\n    if (submitting) return;\n    monthIndex += direction;\n    const month = months[monthIndex];\n    selectDay(Object.keys(days).find(key => key.startsWith(month)) || `${month}-01`);\n  });\n}\nretryCalendar.addEventListener('click', () => loadAvailability(date));\nform.addEventListener('input', () => { if (!submitting) form.elements.requestId.value = ''; });\nform.addEventListener('change', event => { if (event.target.name === 'technicianVisit' && !submitting) loadAvailability(); });\nform.addEventListener('submit', async event => {\n  event.preventDefault();\n  if (submitting || !form.elements.slotId.value) return;\n  submitting = true;\n  submit.disabled = true;\n  form.elements.requestId.value ||= await liveRequestId();\n  status.hidden = false;\n  status.textContent = 'Sending your request…';\n  try {\n    const response = await fetch(form.action, {\n      method: 'POST', body: new URLSearchParams(new FormData(form)), headers: { Accept: 'application/json' },\n    });\n    const result = await response.json();\n    if (response.ok && result.ok) {\n      status.textContent = 'Request received. One moment…';\n      location.href = result.customerEmailSent ? '/thanks' : '/thanks?email=pending';\n      return;\n    }\n    status.textContent = result.message || 'We couldn’t send your request. Please try again.';\n    if (response.status === 409 && ['slot_taken','unavailable','cancel_period'].includes(result.code)) await loadAvailability(date);\n  } catch {\n    status.textContent = 'We couldn’t confirm your request. Please press Send again — you won’t be booked twice — or call or text 620-869-1692.';\n  }\n  submitting = false;\n  submit.disabled = !form.elements.slotId.value;\n});\n\nloadAvailability();\n";
const plpBeforeLive = worker_default.fetch.bind(worker_default);
async function plpLiveFetch(request, env, ctx) {
  PLP_LIVE_ON = !!env.PLP_BOOKING_LIVE_KEY;
  const url = new URL(request.url);
  if ((url.pathname === '/blog' || url.pathname.startsWith('/blog/')) && url.protocol === 'https:' && !url.hostname.startsWith('www.') && request.method === 'GET') return plpBlog(request, env, ctx, url);
  if (!PLP_LIVE_ON || url.protocol !== 'https:' || url.hostname.startsWith('www.')) return plpBeforeLive(request, env, ctx);
  const liveEnv = { ...env, PLP_SUPABASE_PUBLISHABLE_KEY: PLP_TEST_PUBLIC_KEY };
  if (url.pathname === '/api/availability') return liveAvailability(request, liveEnv);
  if (url.pathname === '/api/booking') return liveBooking(request, liveEnv);
  if (url.pathname === '/booking-app.js') return new Response(LIVE_CLIENT_JS, { headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'text/javascript; charset=utf-8' } });
  const response = await plpBeforeLive(request, env, ctx);
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && response.headers.get('Content-Type')?.includes('text/html')) {
    const out = new HTMLRewriter()
      .on('script[src="/assets/appointments.js"]', { element(el) { el.setAttribute('src', '/booking-app.js'); } })
      .on('#requestForm', { element(el) { el.append('<input type="hidden" name="slotId">', { html: true }); } })
      .on('#book .fields', { element(el) { el.append("<div class=\"field\"><label for=\"referredBy\">Who referred you? (optional)</label><input id=\"referredBy\" name=\"referredBy\" maxlength=\"100\" autocomplete=\"off\"></div><div class=\"field\"><label for=\"referrerPhone\">Their phone number (optional)</label><input id=\"referrerPhone\" name=\"referrerPhone\" type=\"tel\" maxlength=\"40\" autocomplete=\"off\"></div>", { html: true }); } })
      .transform(response);
    out.headers.delete('ETag'); out.headers.set('Cache-Control', 'no-cache');
    return out;
  }
  return response;
}
// Adds a "Blog" link to the first menu and to the footer of every page, styled like the links already there.
function plpAddBlogLinks(response) {
  if (!response.headers.get('Content-Type')?.includes('text/html')) return response;
  const mob = { done: false }, nav = { done: false, cls: null, seen: false }, foot = { done: false, cls: null, has: false };
  const link = cls => '<a href="/blog"' + (cls ? ' class="' + cls.replace(/\b(active|current|is-active)\b/g, '').trim() + '"' : '') + '>Blog</a>';
  const out = new HTMLRewriter()
    .on('a[href="/blog"]', { element() { nav.has = true; } })
    .on('nav', { element(el) {
      if (nav.done || nav.seen) return; nav.seen = true;
      el.onEndTag(end => { if (!nav.done && !nav.has) { end.before(link(nav.cls), { html: true }); nav.done = true; } });
    } })
    .on('nav a', { element(el) {
      if (nav.done) return;
      if (nav.cls === null) nav.cls = el.getAttribute('class') || '';
      if (!nav.has && /\bbtn\b/.test(el.getAttribute('class') || '')) { el.before(link(nav.cls), { html: true }); nav.done = true; }
    } })
    .on('#mobilemenu', { element(el) { el.onEndTag(end => { if (!mob.done) { end.before('<a href="/blog">Blog</a>', { html: true }); mob.done = true; } }); } })
    .on('#mobilemenu a', { element(el) {
      if (mob.done) return;
      if ((el.getAttribute('href') || '') === '/blog') { mob.done = true; return; }
      if (/#book$/.test(el.getAttribute('href') || '')) { el.before('<a href="/blog">Blog</a>', { html: true }); mob.done = true; }
    } })
    .on('footer a', { element(el) { foot.has = true; if (foot.cls === null) foot.cls = el.getAttribute('class') || ''; } })
    .on('footer', { element(el) {
      if (foot.done) return;
      el.onEndTag(end => { if (!foot.done) { end.before('<p class="plp-blog-link" style="margin:8px 0 0">' + link(foot.cls) + '</p>', { html: true }); foot.done = true; } });
    } })
    .transform(response);
  out.headers.delete('ETag');
  return out;
}
worker_default.fetch = async function(request, env, ctx) {
  const response = await plpLiveFetch(request, env, ctx);
  return request.method === 'GET' ? plpAddBlogLinks(response) : response;
};
