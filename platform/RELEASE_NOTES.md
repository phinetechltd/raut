# Raut — November 2026 update

**See where every van is.** The Routing page now opens with a live map of your
reps' vehicles and the roads they have driven today. A pin is green when the
handset reported in the last fifteen minutes, amber within the hour and red
beyond that, and the table beside it shows the plate, when the rep was last
seen, their speed, the handset's battery and how far through the day's route
they are. It refreshes itself every 45 seconds while the page is open.

**Vehicles are now part of the plan.** Add your vans, pick-ups and bikes under
Routing → Vehicles, give each a usual driver, and routes are planned against
them. Each route shows its plate, the odometer readings the rep entered at the
start and end of the day, and — once the route is finished — the distance the
van actually drove next to the distance that was planned, so a day that ran
long is visible without anyone asking.

**Skip a stop, and the rest of the day re-routes.** When a shop is shut, the
rep marks the stop as skipped with a reason; the customer's visit is recorded
as missed and the remaining stops are re-ordered from where the rep actually
is, so the next stop is the nearest one rather than the one the morning plan
said. Finished and skipped stops keep their place, so the day's record stays
honest.

**Tracking keeps working when the phone is in a pocket.** The field app asks
for "allow all the time" location, keeps reporting while a van sits in traffic
(a position every minute, not only when it moves), and sends the battery level
with every fix. A trail that was sent twice because of a poor signal is stored
once.

**Choose Google Maps or OpenStreetMap.** Every map in the console — customer
locations, today's field activity, routes and each customer's profile — can now
run on Google Maps instead of OpenStreetMap. Your administrator chooses under
Settings → Maps and can add your company's own Google Maps key, or your
platform administrator can set it for you. Nothing changes until someone
chooses: OpenStreetMap stays the default.

**The field app's Directions follow the same choice.** A rep can tap Directions
on a stop or a customer and be handed to Google Maps or to their installed maps
app, whichever the office picked, instead of searching for the shop themselves.

**A bad Google key shows you a map anyway.** If Google refuses the key — wrong
key, billing lapsed, restricted to another website — the console shows the map
on OpenStreetMap and tells you why, rather than a grey box. The settings screen
previews the live map so a mistyped key is caught where it was typed.

**KRA filings cannot go twice, and cannot vanish.** A sale that Digitax is still
processing is read back rather than sent again; a reply that never arrived is
checked before anything is re-sent; "already filed" is treated as filed and
reconciled, never marked rejected; and pressing Retry in the office while a rep
presses "Send all" produces one filing, not two. Anything KRA will not take —
a malformed PIN, an item it refuses, eight failures in a row — now shows on the
Finance → eTIMS page with the reason, instead of waiting silently for ever. A
product can be marked exempt rather than zero-rated, and the handset's "Send
all" count only counts what KRA actually accepted.

# Raut — September 2026 update

**Returns now credit exactly what the customer paid.** When goods come back from
a sale that had a discount, the credit note gives back the full amount charged,
VAT included. A sale returned in several parts adds up to the cent, and a fully
returned sale leaves nothing owing on the customer's account.

**Discounted sales are reported to KRA correctly.** The taxable amount and VAT
sent to eTIMS for a discounted sale now match what the customer was charged.

**Every return is filed with KRA under its own number.** A second return against
the same sale no longer clashes with the first.

**The same goods can't be returned twice.** If two returns for the same goods are
made at the same moment, only one goes through.

**A refused return tells you why.** You'll see "only 2 remain to be returned" or
"this invoice is already cancelled" instead of "Something went wrong".

**Field reps can take returns on the spot.** A rep can raise the return where
the goods are handed back, instead of sending the customer to the office.

**Your reps' routes reach the office.** Locations recorded while a phone was
standing still were being turned away, so routes weren't arriving. Now they do.

**The app respects each person's role.** Staff can no longer record sales,
payments or customer changes from the field app that their role doesn't allow,
and features outside your subscription stay locked there too.

**Customers and expense claims sent from phones are checked.** A new customer
needs a name, and an expense claim needs a description and an amount.
