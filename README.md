# Prairie Canvassing (iPhone / web)

Door-to-door canvassing app for Prairie Lint Patrol. Open the site in Safari on an iPhone and choose
**Share → Add to Home Screen** so it opens like an app.

- Map with street and satellite views, house outlines and official Kansas 911 addresses
- Tap a house, tap a result to save it; history, search for call-backs, CSV export/import
- Doors are saved on the phone first and shared with the Android app through Supabase

`config.js` holds the Supabase project URL and its *publishable* key, which is designed to be public.
Access to the door data is limited to signed-in people whose email is on the `crew` list.
