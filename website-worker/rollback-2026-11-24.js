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
 .on("#book .fields", { element(el) { el.prepend("<fieldset class=\"field full contact-options plp-visit-options\"><legend>Did a Prairie Lint Patrol technician stop by your home before you booked? *</legend><label><input type=\"radio\" name=\"technicianVisit\" value=\"yes\" required> Yes</label><label><input type=\"radio\" name=\"technicianVisit\" value=\"no\" required> No</label></fieldset><div class=\"field full\"><label for=\"preferredTime\">Preferred time of day</label><select id=\"preferredTime\" name=\"preferredTime\"><option value=\"any\">Any time</option><option value=\"morning\">Morning</option><option value=\"afternoon\">Afternoon</option><option value=\"evening\">Evening</option></select><small>Your selected appointment window is your requested time; this preference helps us arrange alternatives if needed.</small></div>", {html:true}); } })
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
