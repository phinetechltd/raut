"""Builds the Raut Field Sales handbook.

Two rules this file follows:

Colours are sampled from the supplied logo (see palette.py) rather than picked,
so the document and the artwork agree. And the logo is never recoloured to suit
a background — where the navy wordmark would disappear, the background changes
instead.

Every screenshot is a real capture from the running app. A manual whose screens
do not match the device is one the reader stops trusting on page two.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from PIL import Image
from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[2]
SHOTS = Path(__file__).resolve().parent / "shots"
OUT = Path(__file__).resolve().parent / "Raut-Field-Sales-Handbook.pdf"

# ── brand, straight off the logo ──────────────────────────────────────────
NAVY = HexColor("#032646")
NAVY_DEEP = HexColor("#011C3A")
CYAN = HexColor("#03ADE0")
TEAL = HexColor("#06B4B8")
GREEN = HexColor("#45CC13")
GREEN_INK = HexColor("#2E8B0C")
AMBER = HexColor("#B45309")
RED = HexColor("#B42318")
INK = HexColor("#1B2A3A")
MUTED = HexColor("#5B6B7C")
RULE = HexColor("#D9E2EA")
WASH = HexColor("#F3F7FA")
WHITE = Color(1, 1, 1)

W, H = A4
M = 18 * 2.83465

BOLD = "Helvetica-Bold"
BODY = "Helvetica"
MONO = "Courier"

BAND = 26 * 2.83465          # header band height


class Doc:
    def __init__(self, path: Path):
        self.c = canvas.Canvas(str(path), pagesize=A4)
        self.c.setTitle("Raut Field Sales — Handbook")
        self.c.setAuthor("Tari Africa Platforms Limited")
        self.c.setSubject("Routes, customers, orders, payments and sales returns")
        self.page = 0
        self.section = ""

    # ── primitives ────────────────────────────────────────────────────────
    def text(self, x, y, s, font=BODY, size=10, colour=INK, leading=None):
        self.c.setFont(font, size)
        self.c.setFillColor(colour)
        self.c.drawString(x, y, s)
        return y - (leading or size * 1.45)

    def wrap(self, x, y, s, width, font=BODY, size=10, colour=INK, leading=None):
        """Word-wraps to `width`; a raw canvas has no soft wrap of its own."""
        lead = leading or size * 1.5
        self.c.setFont(font, size)
        self.c.setFillColor(colour)
        line = ""
        for word in s.split():
            trial = f"{line} {word}".strip()
            if self.c.stringWidth(trial, font, size) <= width:
                line = trial
            else:
                self.c.drawString(x, y, line)
                y -= lead
                line = word
        if line:
            self.c.drawString(x, y, line)
            y -= lead
        return y

    def shot(self, name, x, y, max_w, max_h):
        path = SHOTS / name
        im = Image.open(path)
        r = min(max_w / im.width, max_h / im.height)
        w, h = im.width * r, im.height * r
        self.c.setStrokeColor(RULE)
        self.c.setLineWidth(0.8)
        self.c.roundRect(x - 2, y - h - 2, w + 4, h + 4, 6, stroke=1, fill=0)
        self.c.drawImage(ImageReader(str(path)), x, y - h, w, h, mask="auto")
        return w, h

    def badge(self, x, y, n, colour=CYAN):
        self.c.setFillColor(colour)
        self.c.circle(x + 8, y + 3, 9.5, stroke=0, fill=1)
        self.c.setFillColor(WHITE)
        self.c.setFont(BOLD, 10)
        self.c.drawCentredString(x + 8, y, str(n))

    def note(self, x, y, w, title, body, accent=CYAN, bg=WASH, ink=NAVY, sub=MUTED):
        """A tinted callout. Height is measured first so it never clips."""
        self.c.setFont(BODY, 9.5)
        lines, line = 1, ""
        for word in body.split():
            t = f"{line} {word}".strip()
            if self.c.stringWidth(t, BODY, 9.5) <= w - 30:
                line = t
            else:
                lines += 1
                line = word
        h = 30 + lines * 13 + 8

        self.c.setFillColor(bg)
        self.c.roundRect(x, y - h, w, h, 7, stroke=0, fill=1)
        self.c.setFillColor(accent)
        self.c.rect(x, y - h, 3.5, h, stroke=0, fill=1)
        self.c.setFont(BOLD, 10.5)
        self.c.setFillColor(ink)
        self.c.drawString(x + 15, y - 21, title)
        self.wrap(x + 15, y - 37, body, w - 30, size=9.5, colour=sub, leading=13)
        return y - h - 14

    def bullets(self, x, y, items, width, colour=CYAN):
        for label, detail in items:
            self.c.setFillColor(colour)
            self.c.circle(x + 3, y + 3.5, 2.8, stroke=0, fill=1)
            self.c.setFont(BOLD, 10)
            self.c.setFillColor(INK)
            self.c.drawString(x + 14, y, label)
            wlab = self.c.stringWidth(label, BOLD, 10)
            y = self.wrap(x + 14 + wlab + 6, y, f"— {detail}",
                          width - wlab - 20, size=10, colour=MUTED, leading=14)
            y -= 5
        return y

    # ── page furniture ────────────────────────────────────────────────────
    def header(self, title, kicker=""):
        c = self.c
        c.setFillColor(NAVY)
        c.rect(0, H - BAND, W, BAND, stroke=0, fill=1)
        c.setFillColor(CYAN)
        c.rect(0, H - BAND, W, 2.2, stroke=0, fill=1)

        y = H - 30
        if kicker:
            c.setFont(BOLD, 8)
            c.setFillColor(CYAN)
            c.drawString(M, y, kicker.upper())
            y -= 16
        c.setFont(BOLD, 17)
        c.setFillColor(WHITE)
        c.drawString(M, y - 4, title)

        # The mark alone reads on navy; the full lockup would not.
        logo = ROOT / "brand" / "raut-mark.png"
        if logo.exists():
            im = Image.open(logo)
            h = 26
            c.drawImage(ImageReader(str(logo)), W - M - im.width * (h / im.height),
                        H - 52, im.width * (h / im.height), h, mask="auto")
        return H - BAND - 32

    def footer(self):
        self.page += 1
        c = self.c
        c.setStrokeColor(RULE)
        c.setLineWidth(0.8)
        c.line(M, 42, W - M, 42)
        c.setFont(BODY, 8)
        c.setFillColor(MUTED)
        c.drawString(M, 30, f"Raut Field Sales  ·  {self.section}")
        c.drawRightString(W - M, 30, str(self.page))

    def end(self, footer=True):
        if footer:
            self.footer()
        self.c.showPage()

    def save(self):
        self.c.save()


def build() -> Path:
    d = Doc(OUT)
    c = d.c
    inner = W - 2 * M

    # ══ cover ═════════════════════════════════════════════════════════════
    c.setFillColor(NAVY_DEEP)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(CYAN)
    c.rect(0, H * 0.60, W, 5, stroke=0, fill=1)
    c.setFillColor(TEAL)
    c.rect(0, H * 0.60 - 5, W, 5, stroke=0, fill=1)
    c.setFillColor(GREEN)
    c.rect(0, H * 0.60 - 10, W * 0.22, 5, stroke=0, fill=1)

    logo = ROOT / "brand" / "raut-logo-tagline.png"
    if logo.exists():
        im = Image.open(logo)
        w = 210
        h = im.height * (w / im.width)
        pad = 24
        c.setFillColor(WHITE)
        c.roundRect(M - pad, H * 0.72 - pad, w + pad * 2, h + pad * 2, 10, stroke=0, fill=1)
        c.drawImage(ImageReader(str(logo)), M, H * 0.72, w, h, mask="auto")

    y = H * 0.50
    c.setFont(BOLD, 31)
    c.setFillColor(WHITE)
    c.drawString(M, y, "Field Sales Handbook")
    c.setFont(BODY, 14.5)
    c.setFillColor(CYAN)
    c.drawString(M, y - 27, "Routes, customers, orders, payments and returns")

    c.setFont(BODY, 10.5)
    c.setFillColor(HexColor("#B9C9D8"))
    ty = y - 64
    for line in [
        "Everything a sales representative does on a round, on an Android",
        "POS device — including how to take goods back and file the credit",
        "with KRA.",
    ]:
        c.drawString(M, ty, line)
        ty -= 16

    c.setFillColor(HexColor("#6E8296"))
    c.setFont(BODY, 9)
    c.drawString(M, 92, "Tari Africa Platforms Limited  ·  Nairobi")
    c.drawString(M, 78, f"Version 1.2  ·  {dt.date.today():%B %Y}")
    d.end(footer=False)

    # ══ contents ══════════════════════════════════════════════════════════
    d.section = "Contents"
    y = d.header("What is in this handbook", "Contents")

    y = d.wrap(
        M, y,
        "Read it in order the first time. After that, the section you need is "
        "listed below — each one is a single page you can find quickly with the "
        "device in your hand.",
        inner, size=11, leading=17,
    )
    y -= 16

    contents = [
        ("Your day", "Today's route", "Your stops in order, and closing each one off"),
        ("", "Checking in at a shop", "The GPS check, and calling on shops off your route"),
        ("", "Customers", "Finding a shop, and what the app remembers about it"),
        ("Selling", "Taking an order", "Selling by carton, dozen or single"),
        ("", "Collecting payment", "Cash, M-Pesa, bank, cheque and card"),
        ("Closing the day", "Your day at a glance", "Visits, orders and cash you have taken today"),
        ("", "Claiming expenses", "Fuel, airtime and travel, claimed on the spot"),
        ("Returns", "What a return is", "And when to use one"),
        ("", "Step 1 — find the sale", "Opening the invoice the goods came from"),
        ("", "Step 2 — open the receipt", "Checking whether KRA has it"),
        ("", "Step 3 — record what came back", "Counting, reasons, and restocking"),
        ("", "Step 4 — hand over the credit note", "Printing it for the customer"),
        ("If it goes wrong", "When KRA has not answered", "Interim documents, and pushing them through"),
        ("", "Working without signal", "What the app does when you are offline"),
        ("", "What is waiting to be sent", "The sync queue, item by item"),
        ("The More tab", "Everything else", "Sync, expenses, tracking and your subscription"),
    ]

    for group, title, detail in contents:
        if group:
            y -= 6
            c.setFont(BOLD, 8.5)
            c.setFillColor(CYAN)
            c.drawString(M, y, group.upper())
            y -= 16
        c.setFillColor(RULE)
        c.rect(M, y - 6, inner, 0.7, stroke=0, fill=1)
        c.setFont(BOLD, 10.5)
        c.setFillColor(NAVY)
        c.drawString(M + 10, y + 2, title)
        c.setFont(BODY, 9.5)
        c.setFillColor(MUTED)
        c.drawString(M + 210, y + 2, detail)
        y -= 22

    y -= 10
    d.note(
        M, y, inner, "Before your first round",
        "Sign in once with the address the office gave you. The app then downloads your "
        "route, your customers and the price list, and keeps working whether or not you "
        "have a signal after that.",
        accent=TEAL,
    )
    d.end()

    # ══ today's route ═════════════════════════════════════════════════════
    d.section = "Your day"
    y = d.header("Today's route", "Your day")

    sw, sh = d.shot("02-route.png", M, y, 190, 408)
    tx = M + sw + 28
    tw = inner - sw - 28
    ty = y

    ty = d.wrap(
        tx, ty,
        "The app opens on your route. Stops are in the order the office planned them, "
        "with the distance and driving time for the whole round at the top.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 8

    ty = d.text(tx, ty, "What each stop tells you", BOLD, 11.5, NAVY, 20)
    ty = d.bullets(tx, ty, [
        ("The number", "where it sits in the round; a tick means it is done"),
        ("The time", "when the office expects you there"),
        ("What they owe", "shown in amber, or red when it is over their credit limit"),
        ("verified", "your check-in was inside the shop's geofence"),
    ], tw)

    ty -= 6
    ty = d.note(
        tx, ty, tw, "Stops you add yourself",
        "Calling on a shop that is not on today's list is fine. Find them under Customers "
        "and start a visit — it joins your route and reaches the office like any other.",
        accent=CYAN,
    )
    d.note(
        tx, ty, tw, "Tap the refresh icon any time",
        "It sends anything waiting on the handset and pulls down whatever has changed.",
        accent=TEAL,
    )

    y = y - sh - 30
    y = d.text(M, y, "Closing a stop", BOLD, 12.5, NAVY, 22)
    sw2, sh2 = d.shot("09-visit-outcome.png", M, y, 118, 210)
    tx = M + sw2 + 26
    tw = inner - sw2 - 26
    ty = y
    ty = d.wrap(
        tx, ty,
        "Tap Check out when you leave and say how the visit went. This is what the office "
        "sees when they look at the day, so a shop that was closed is worth recording as "
        "exactly that rather than leaving blank.",
        tw, size=10, colour=MUTED, leading=15,
    )
    ty -= 6
    d.wrap(
        tx, ty,
        "Notes are optional and go to your manager, not the customer.",
        tw, size=10, colour=MUTED, leading=15,
    )
    d.end()

    # ══ checking in ═══════════════════════════════════════════════════════
    y = d.header("Checking in at a shop", "Your day")

    sw, sh = d.shot("21-geofence.png", M, y, 190, 408)
    tx = M + sw + 28
    tw = inner - sw - 28
    ty = y

    ty = d.wrap(
        tx, ty,
        "Check in when you arrive and out when you leave. Everything you do in between — "
        "the order, the payment, the return — is attached to that visit, which is how the "
        "office sees a round as it actually happened rather than as a list of totals.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 8

    ty = d.text(tx, ty, "The GPS check", BOLD, 11.5, NAVY, 20)
    ty = d.wrap(
        tx, ty,
        "When you check in, the app compares where you are standing with the shop's pin. "
        "Inside the range, the visit is marked verified. Outside it, you are told the "
        "distance and the visit is recorded anyway — marked unverified.",
        tw, size=10, colour=MUTED, leading=15,
    )
    ty -= 6
    ty = d.bullets(tx, ty, [
        ("You are never blocked", "a far check-in still saves; it is flagged, not refused"),
        ("If the shop moved", "tap Update to correct the pin while you are there"),
        ("Credit warnings", "a customer over their limit is called out before you sell"),
    ], tw)

    ty -= 4
    d.note(
        tx, ty, tw, "Why it is flagged, not blocked",
        "A pin can be wrong, a mast can be poor, and a shop can move. Refusing the check-in "
        "would cost you the visit. Recording it honestly costs you a conversation.",
        accent=AMBER,
    )

    y = y - sh - 30
    y = d.text(M, y, "Calling on a shop that is not on today's route", BOLD, 12.5, NAVY, 22)
    sw2, sh2 = d.shot("20-unplanned-visit.png", M, y, 118, 210)
    tx = M + sw2 + 26
    tw = inner - sw2 - 26
    ty = y
    ty = d.wrap(
        tx, ty,
        "Open the shop from Customers and start a visit there and then. It is added to "
        "your route as an unplanned stop and syncs like any other, so a call you made on "
        "your own initiative still counts as work done.",
        tw, size=10, colour=MUTED, leading=15,
    )
    ty -= 4
    d.wrap(
        tx, ty,
        "This works with no signal. The visit, the check-in and anything you sell are held "
        "on the handset until there is coverage.",
        tw, size=10, colour=MUTED, leading=15,
    )
    d.end()

    # ══ customers ═════════════════════════════════════════════════════════
    y = d.header("Customers", "Your day")

    sw, sh = d.shot("11-customers.png", M, y, 190, 408)
    tx = M + sw + 28
    tw = inner - sw - 28
    ty = y

    ty = d.wrap(
        tx, ty,
        "Every shop assigned to you, searchable by name, code, phone or town. Use it to "
        "call on a customer who is not on today's route.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 8

    ty = d.text(tx, ty, "On each row", BOLD, 11.5, NAVY, 20)
    ty = d.bullets(tx, ty, [
        ("Balance", "what they owe right now, red once they are over their limit"),
        ("Owing money", "a filter, for when you are chasing collections"),
        ("The pin", "green when the shop's location is on file, so check-in can be verified"),
        ("A, B or C", "the segment the office has put them in"),
    ], tw)

    ty -= 6
    d.note(
        tx, ty, tw, "Adding a shop",
        "Tap New to register a customer you find on the road. Capture their location while "
        "you are standing there — that pin is what lets future check-ins be verified.",
        accent=GREEN_INK,
    )

    y = y - sh - 30
    y = d.text(M, y, "What the app remembers about a shop", BOLD, 12.5, NAVY, 22)
    sw2, sh2 = d.shot("12-customer.png", M, y, 118, 210)
    tx = M + sw2 + 26
    tw = inner - sw2 - 26
    ty = y
    ty = d.wrap(
        tx, ty,
        "Opening a customer shows the visit as it happened: when you arrived, when you "
        "left, how long you were there, whether the check-in was inside the geofence, and "
        "what you recorded as the outcome.",
        tw, size=10, colour=MUTED, leading=15,
    )
    ty -= 4
    d.wrap(
        tx, ty,
        "Their outstanding invoices are listed underneath, oldest first, with anything "
        "overdue in red. Each one can be opened as a receipt.",
        tw, size=10, colour=MUTED, leading=15,
    )
    d.end()

    # ══ taking an order ═══════════════════════════════════════════════════
    d.section = "Selling"
    y = d.header("Taking an order", "Selling")

    sw, sh = d.shot("14-order-units.png", M, y, 236, 530)
    tx = M + sw + 26
    tw = inner - sw - 26
    ty = y

    ty = d.wrap(
        tx, ty,
        "Search or scroll to the product, choose the unit the shop is buying, and set the "
        "quantity. Totals build at the bottom as you go.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 10

    for n, head, body in [
        (1, "Pick the selling unit",
         "Carton, dozen or single — whatever the shop takes. The chips under each product "
         "are the units your company sells it in."),
        (2, "The price follows the unit",
         "A dozen is not twelve times the single price. The app shows what one unit works "
         "out at underneath, so you can answer \"is the dozen cheaper\" without doing sums."),
        (3, "Watch the van count",
         "Stock on your vehicle is shown beside the price. You can still order more than "
         "you are carrying — it turns amber to tell you the warehouse will fulfil it."),
    ]:
        d.badge(tx, ty - 8, n)
        d.text(tx + 28, ty - 8, head, BOLD, 11.5, NAVY, 0)
        ty = d.wrap(tx, ty - 30, body, tw, size=9.8, colour=MUTED, leading=14)
        ty -= 12

    ty -= 2
    ty = d.note(
        tx, ty, tw, "One product, one stock pool",
        "Selling a dozen takes twelve off the shelf, not one. You never have to convert "
        "anything or keep separate counts.",
        accent=TEAL,
    )
    d.note(
        tx, ty, tw, "Over the credit limit",
        "If the shop is over its limit the app warns you before saving. Your manager can "
        "approve it; you do not have to turn the order away on the spot.",
        accent=AMBER, bg=HexColor("#FFF7E8"), ink=AMBER, sub=HexColor("#7C4A0A"),
    )
    d.end()

    # ══ collecting payment ════════════════════════════════════════════════
    y = d.header("Collecting payment", "Selling")

    sw, sh = d.shot("04-payment.png", M, y, 236, 530)
    tx = M + sw + 26
    tw = inner - sw - 26
    ty = y

    ty = d.wrap(
        tx, ty,
        "Enter what you were handed, choose how it was paid, and save. The payment is "
        "applied to the oldest invoices first.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 10

    ty = d.text(tx, ty, "Money already in your hand", BOLD, 11.5, NAVY, 20)
    ty = d.bullets(tx, ty, [
        ("Cash", "counted at the counter"),
        ("M-Pesa code", "the customer paid to the till; type the confirmation code"),
        ("Bank transfer", "record the reference from their slip"),
        ("Cheque", "record the cheque number"),
    ], tw)

    ty -= 4
    ty = d.text(tx, ty, "Asking the customer to pay now", BOLD, 11.5, NAVY, 20)
    ty = d.wrap(
        tx, ty,
        "Under Collect now the app can send a request straight to the customer's phone. "
        "Which options appear depends on what your company has set up — if nothing is "
        "configured, the section is not shown at all.",
        tw, size=9.8, colour=MUTED, leading=14,
    )
    ty -= 4
    ty = d.bullets(tx, ty, [
        ("M-Pesa", "an STK prompt on their handset; they enter their PIN"),
        ("Card / Paystack", "a secure link they complete on their own phone"),
    ], tw, colour=TEAL)

    ty -= 2
    ty = d.note(
        tx, ty, tw, "Their number is already filled in",
        "The app uses the phone number on the customer's record. Change it on the spot if "
        "they are paying from a different line.",
        accent=CYAN,
    )
    d.note(
        tx, ty, tw, "Wait for the customer to confirm",
        "The screen holds while they enter their PIN. If they never do, nothing is "
        "recorded — no money moves and no receipt is issued.",
        accent=AMBER, bg=HexColor("#FFF7E8"), ink=AMBER, sub=HexColor("#7C4A0A"),
    )
    d.end()

    # ══ your day at a glance ══════════════════════════════════════════════
    d.section = "Closing the day"
    y = d.header("Your day at a glance", "Closing the day")

    sw, sh = d.shot("16-today.png", M, y, 190, 408)
    tx = M + sw + 28
    tw = inner - sw - 28
    ty = y

    ty = d.wrap(
        tx, ty,
        "The Today tab is your own scoreboard, counted from the work on your handset. It "
        "is the quickest way to check you have closed everything off before you head back.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 8

    ty = d.text(tx, ty, "The four figures", BOLD, 11.5, NAVY, 20)
    ty = d.bullets(tx, ty, [
        ("Visits done", "completed against scheduled — 5/8 means three stops left"),
        ("GPS verified", "how many of those check-ins were inside the shop's range"),
        ("Orders", "orders raised today, whether or not they have synced"),
        ("Collected", "money taken today, across every payment method"),
    ], tw)

    ty -= 6
    ty = d.text(tx, ty, "Underneath", BOLD, 11.5, NAVY, 20)
    d.wrap(
        tx, ty,
        "A plain statement of whether your work has reached the office, and when it last "
        "went. Sync now forces a send if you want to watch it happen before you sign off.",
        tw, size=10, colour=MUTED, leading=15,
    )

    y = y - sh - 30
    d.note(
        M, y, inner, "These are your figures, not the branch's",
        "Everything here counts only what you did, on this handset. Branch and company "
        "totals live in the console, where your manager sees every rep together.",
        accent=TEAL,
    )
    d.end()

    # ══ expense claims ════════════════════════════════════════════════════
    y = d.header("Claiming expenses", "Closing the day")

    sw, sh = d.shot("19-expense.png", M, y, 190, 408)
    tx = M + sw + 28
    tw = inner - sw - 28
    ty = y

    ty = d.wrap(
        tx, ty,
        "Fuel, airtime, a matatu fare, a puncture. Claim it from More › Expense claim "
        "while you are still standing there, rather than reconstructing the day from "
        "receipts in your pocket a week later.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 8

    ty = d.text(tx, ty, "What to fill in", BOLD, 11.5, NAVY, 20)
    ty = d.bullets(tx, ty, [
        ("What it was for", "one line your manager can approve without asking"),
        ("Amount", "in shillings"),
        ("Category", "fuel, airtime and data, travel, vehicle, or miscellaneous"),
        ("How you paid", "cash, M-Pesa or petty cash"),
    ], tw)

    ty -= 6
    ty = d.wrap(
        tx, ty,
        "Your location is attached to the claim automatically, and it syncs to your "
        "manager for approval like any other work.",
        tw, size=10, colour=MUTED, leading=15,
    )

    ty -= 4
    d.note(
        tx, ty, tw, "Works with no signal",
        "A claim raised in a dead spot is held on the handset and sent when coverage "
        "returns, exactly like an order.",
        accent=GREEN_INK,
    )
    d.end()

    # ══ what a return is ══════════════════════════════════════════════════
    d.section = "Returns"
    y = d.header("What a return is", "Returns")

    y = d.wrap(
        M, y,
        "A return is what you record when a customer gives goods back. It does not change "
        "the original invoice: that sale happened, the customer has their copy, and KRA "
        "has ours. Instead the app raises a credit note — a separate document that credits "
        "the customer and is filed with KRA in its own right.",
        inner, size=11, leading=17,
    )
    y -= 12

    card_w = (inner - 24) / 3
    cards = [
        ("The sale stands", "The invoice is not edited or deleted. It stays exactly as it was issued.", CYAN),
        ("The customer is credited", "What they owe drops by the value of what came back.", TEAL),
        ("KRA is told", "The credit note is filed and gets its own control code.", GREEN_INK),
    ]
    top = y
    for i, (head, body, colour) in enumerate(cards):
        x = M + i * (card_w + 12)
        c.setFillColor(WASH)
        c.roundRect(x, top - 100, card_w, 100, 7, stroke=0, fill=1)
        c.setFillColor(colour)
        c.rect(x, top - 100, 3.5, 100, stroke=0, fill=1)
        c.setFont(BOLD, 10.5)
        c.setFillColor(NAVY)
        c.drawString(x + 14, top - 24, head)
        d.wrap(x + 14, top - 42, body, card_w - 26, size=9, colour=MUTED, leading=12.5)
    y = top - 100 - 28

    y = d.text(M, y, "When to use it", BOLD, 13, NAVY, 22)
    y = d.bullets(M, y, [
        ("Damaged or leaking stock", "credited, and not put back on your van"),
        ("Wrong item delivered", "credited and restocked, ready to sell again"),
        ("Short-dated or expired goods", "credited, and written off rather than restocked"),
        ("Customer over-ordered", "credited and restocked"),
    ], inner)

    y -= 10
    y = d.text(M, y, "What happens the moment you save it", BOLD, 13, NAVY, 22)
    steps = [
        "The customer's balance drops by the credited amount.",
        "Sellable goods go back onto your van; damaged goods do not.",
        "The credit note is sent to KRA and comes back with its own control code.",
        "The office sees it on the books straight away, attributed to you.",
    ]
    for i, s in enumerate(steps, start=1):
        d.badge(M, y - 4, i, colour=TEAL)
        y = d.wrap(M + 28, y, s, inner - 28, size=10, colour=MUTED, leading=14)
        y -= 8

    y -= 4
    d.note(
        M, y, inner, "A return cannot be undone",
        "Once raised, a credit note stays on the record. If you credit the wrong amount, "
        "tell the office — they correct it with another document, never by deleting this "
        "one. The app will also stop you crediting more than was sold.",
        accent=AMBER, bg=HexColor("#FFF7E8"), ink=AMBER, sub=HexColor("#7C4A0A"),
    )
    d.end()

    # ══ return step 1 ═════════════════════════════════════════════════════
    y = d.header("Find the sale", "Returns · Step 1 of 4")

    sw, sh = d.shot("03-visit.png", M, y, 236, 530)
    tx = M + sw + 26
    tw = inner - sw - 26
    ty = y

    for n, head, body in [
        (1, "Open the shop",
         "From today's route or from Customers, tap the shop the goods came back from. "
         "Check in if you have not already — the app records where you were when you did."),
        (2, "Tap Payment",
         "The customer's outstanding invoices are listed at the bottom of that screen. "
         "This is where every receipt is reached from."),
        (3, "Pick the invoice the goods were sold on",
         "The small icon on the right opens it. A filed invoice and one still waiting on "
         "KRA show different icons, so you can tell them apart at a glance."),
    ]:
        d.badge(tx, ty - 8, n)
        d.text(tx + 28, ty - 8, head, BOLD, 11.5, NAVY, 0)
        ty = d.wrap(tx, ty - 30, body, tw, size=9.8, colour=MUTED, leading=14)
        ty -= 12

    ty -= 2
    ty = d.note(
        tx, ty, tw, "Not sure which invoice?",
        "Ask for the customer's copy — the number is at the top. If they have lost it, the "
        "amounts on the list will usually identify it.",
        accent=CYAN,
    )
    d.note(
        tx, ty, tw, "Already partly returned",
        "An invoice that has had goods returned before shows what is still owed after "
        "those credits, not the original amount. You are never chasing money the customer "
        "has already been given back.",
        accent=TEAL,
    )
    d.end()

    # ══ return step 2 ═════════════════════════════════════════════════════
    y = d.header("Open the receipt and tap Return", "Returns · Step 2 of 4")

    sw, sh = d.shot("05-receipt-filed.png", M, y, 252, 566)
    tx = M + sw + 26
    tw = inner - sw - 26
    ty = y

    ty = d.wrap(
        tx, ty,
        "This is the sale as the customer received it. The banner at the top is the one to "
        "read first.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 10

    for head, body, colour in [
        ("Filed with KRA",
         "The sale has a control code. This is a valid tax invoice, and you can return "
         "against it straight away.", GREEN_INK),
        ("Not yet filed",
         "KRA has not answered. You can still take the return — it will be filed as soon "
         "as the sale is.", AMBER),
    ]:
        c.setFillColor(colour)
        c.circle(tx + 3.5, ty + 3.5, 3.5, stroke=0, fill=1)
        c.setFont(BOLD, 10.5)
        c.setFillColor(NAVY)
        c.drawString(tx + 14, ty, head)
        ty = d.wrap(tx + 14, ty - 15, body, tw - 14, size=9.5, colour=MUTED, leading=13)
        ty -= 10

    ty -= 4
    ty = d.note(
        tx, ty, tw, "Tap Return, bottom left",
        "If there is no Return button, your role does not include returns. Ask the office "
        "to enable it for you.",
        accent=CYAN,
    )
    d.note(
        tx, ty, tw, "Reprinting the sale",
        "Print receipt gives the customer another copy at any time. A reprint is marked "
        "DUPLICATE so it is never mistaken for a second sale.",
        accent=TEAL,
    )
    d.end()

    # ══ return step 3 ═════════════════════════════════════════════════════
    y = d.header("Record what came back", "Returns · Step 3 of 4")

    sw, sh = d.shot("06-return.png", M, y, 252, 566)
    tx = M + sw + 26
    tw = inner - sw - 26
    ty = y

    for n, head, body in [
        (1, "Count what is being returned",
         "Use + and − on each line. The app will not let you credit more than was sold, or "
         "more than is left after earlier returns — the line tells you how many remain."),
        (2, "Say why",
         "A reason is required. Write what actually happened: the office and the customer "
         "both read it later, and it is what an auditor sees."),
        (3, "Sellable, or not",
         "Leave the switch on if the goods can be sold again — they go back onto your van. "
         "Turn it off for damaged stock: the customer is still credited, but nothing is "
         "added back to what you are carrying."),
    ]:
        d.badge(tx, ty - 8, n)
        d.text(tx + 28, ty - 8, head, BOLD, 11.5, NAVY, 0)
        ty = d.wrap(tx, ty - 30, body, tw, size=9.8, colour=MUTED, leading=14)
        ty -= 12

    ty -= 2
    ty = d.note(
        tx, ty, tw, "The button shows the amount",
        "Check it against what you told the customer before you tap it. Returning a dozen "
        "credits the dozen price, not twelve singles.",
        accent=TEAL,
    )
    d.note(
        tx, ty, tw, "This needs a signal",
        "A return has to reach the office as it is raised. If you have no bars, take the "
        "goods, tell the customer the credit note is coming, and raise it when you are back "
        "in coverage.",
        accent=AMBER, bg=HexColor("#FFF7E8"), ink=AMBER, sub=HexColor("#7C4A0A"),
    )
    d.end()

    # ══ return step 4 ═════════════════════════════════════════════════════
    y = d.header("Hand over the credit note", "Returns · Step 4 of 4")

    sw, sh = d.shot("07-credit-note.png", M, y, 252, 566)
    tx = M + sw + 26
    tw = inner - sw - 26
    ty = y

    ty = d.wrap(
        tx, ty,
        "The return is now its own document, with its own number and its own control code "
        "from KRA. It names the invoice it credits, so the customer and their accountant "
        "can match the two.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 12

    ty = d.text(tx, ty, "What is on the paper", BOLD, 11.5, NAVY, 20)
    for label, detail in [
        ("CREDIT NOTE", "the heading, once KRA has accepted it"),
        ("Against", "the invoice number this credits"),
        ("RETURNED", "what came back, and why"),
        ("CREDITED", "taken off what they owe"),
        ("CONTROL CODE", "KRA's code, with a QR they can scan"),
    ]:
        c.setFont(MONO, 8.5)
        c.setFillColor(NAVY)
        c.drawString(tx, ty, label)
        c.setFont(BODY, 9.3)
        c.setFillColor(MUTED)
        c.drawString(tx + 92, ty, detail)
        ty -= 15

    ty -= 10
    ty = d.note(
        tx, ty, tw, "Print it and give it to the customer",
        "Tap Print note. You can print it again at any time — a second copy is marked "
        "DUPLICATE so it is never mistaken for a second credit.",
        accent=GREEN_INK, bg=HexColor("#ECFDF3"),
        ink=HexColor("#14532D"), sub=HexColor("#166534"),
    )
    d.note(
        tx, ty, tw, "Nothing else to do",
        "The customer's balance is already reduced and the office already has it. Carry on "
        "with your round.",
        accent=TEAL,
    )
    d.end()

    # ══ when KRA has not answered ═════════════════════════════════════════
    d.section = "If it goes wrong"
    y = d.header("When KRA has not answered", "If it goes wrong")

    y = d.wrap(
        M, y,
        "KRA is usually quick, but the line goes down. The app never makes a customer wait "
        "indefinitely, and it never claims a document is something it is not.",
        inner, size=11, leading=17,
    )
    y -= 16

    c.setFillColor(NAVY)
    c.rect(M, y - 22, inner, 22, stroke=0, fill=1)
    c.setFont(BOLD, 8.5)
    c.setFillColor(WHITE)
    c.drawString(M + 12, y - 15, "ON SCREEN")
    c.drawString(M + 140, y - 15, "PRINTED ON THE PAPER")
    c.drawString(M + 292, y - 15, "WHAT YOU DO")
    y -= 22

    rows = [
        ("Filed with KRA", "TAX INVOICE / CREDIT NOTE",
         "Has a control code. Give it to the customer; nothing more to do.", GREEN_INK),
        ("Awaiting KRA", "NOT A TAX INVOICE",
         "Print it so the customer has something. Reprint the proper one once it lands.", AMBER),
        ("Rejected by KRA", "NOT A TAX INVOICE",
         "Something on the sale was refused. Print it, then tell the office.", RED),
    ]
    for i, (state, paper, action, colour) in enumerate(rows):
        rh = 48
        if i % 2 == 0:
            c.setFillColor(WASH)
            c.rect(M, y - rh, inner, rh, stroke=0, fill=1)
        c.setFillColor(colour)
        c.circle(M + 16, y - 18, 3.4, stroke=0, fill=1)
        c.setFont(BOLD, 9.5)
        c.setFillColor(NAVY)
        c.drawString(M + 26, y - 21, state)
        c.setFont(MONO, 8)
        c.setFillColor(colour)
        c.drawString(M + 140, y - 21, paper)
        d.wrap(M + 292, y - 21, action, inner - 292 - 8, size=9, colour=MUTED, leading=12)
        y -= rh

    y -= 28
    y = d.text(M, y, "Pushing a stuck document through yourself", BOLD, 13, NAVY, 24)

    sw, sh = d.shot("08-more.png", M, y, 132, 236)
    tx = M + sw + 26
    tw = inner - sw - 26
    ty = y
    ty = d.wrap(
        tx, ty,
        "More › Awaiting KRA lists everything on your handset that KRA has not accepted — "
        "sales and returns together. It reads \"Everything is filed\" when there is nothing "
        "outstanding, which is what you should normally see.",
        tw, size=10, colour=MUTED, leading=15,
    )
    ty -= 6
    ty = d.wrap(
        tx, ty,
        "Tap Send all when the signal comes back. You do not have to: the office retries on "
        "its own every few minutes. This is for when a customer is standing in front of you "
        "waiting for a proper document.",
        tw, size=10, colour=MUTED, leading=15,
    )
    ty -= 8
    d.note(
        tx, ty, tw, "Never re-key a sale that looks stuck",
        "Raising it again would charge the customer twice. Push it from this screen, or ask "
        "the office.",
        accent=RED, bg=HexColor("#FEF3F2"), ink=RED, sub=HexColor("#912018"),
    )
    d.end()

    # ══ offline ═══════════════════════════════════════════════════════════
    y = d.header("Working without signal", "If it goes wrong")

    y = d.wrap(
        M, y,
        "Most of a round works with no connection at all. The app keeps what you do on the "
        "handset and sends it the moment there is coverage — you do not have to remember "
        "to do anything.",
        inner, size=11, leading=17,
    )
    y -= 16

    col = (inner - 20) / 2
    left = [
        ("Works offline", GREEN_INK, [
            "Checking in and out of a visit",
            "Taking an order",
            "Recording cash, M-Pesa codes, bank and cheque payments",
            "Raising an expense claim",
            "Reprinting any receipt already on the handset",
        ]),
    ]
    right = [
        ("Needs a signal", AMBER, [
            "Sending an M-Pesa or card request to the customer",
            "Raising a return",
            "Filing anything with KRA",
            "Seeing an order the office raised while you were out",
        ]),
    ]

    for items, x in ((left, M), (right, M + col + 20)):
        for head, colour, lines in items:
            c.setFillColor(WASH)
            c.roundRect(x, y - 176, col, 176, 7, stroke=0, fill=1)
            c.setFillColor(colour)
            c.rect(x, y - 176, 3.5, 176, stroke=0, fill=1)
            c.setFont(BOLD, 11)
            c.setFillColor(NAVY)
            c.drawString(x + 15, y - 24, head)
            yy = y - 46
            for line in lines:
                c.setFillColor(colour)
                c.circle(x + 19, yy + 3.5, 2.4, stroke=0, fill=1)
                yy = d.wrap(x + 29, yy, line, col - 44, size=9.3, colour=MUTED, leading=12.5)
                yy -= 4
    y -= 176 + 24

    y = d.text(M, y, "How to tell", BOLD, 13, NAVY, 22)
    y = d.bullets(M, y, [
        ("A grey banner", "\"Offline — you can keep working\". Nothing is lost."),
        ("An amber banner", "counts what is still waiting to reach the office"),
        ("A green tick", "\"Everything synced\", with the time it last ran"),
    ], inner)

    y -= 10
    y = d.note(
        M, y, inner, "Do not sign out with work waiting",
        "Signing out clears the handset. If the sync banner still shows items waiting, get "
        "into coverage and let it finish first.",
        accent=RED, bg=HexColor("#FEF3F2"), ink=RED, sub=HexColor("#912018"),
    )
    d.note(
        M, y, inner, "Battery and the printer",
        "Printing draws heavily on a POS battery. On a long round, charge at lunch rather "
        "than risking the last few stops of the day.",
        accent=CYAN,
    )
    d.end()

    # ══ the sync queue ════════════════════════════════════════════════════
    y = d.header("What is waiting to be sent", "If it goes wrong")

    sw, sh = d.shot("18-sync-queue.png", M, y, 178, 384)
    tx = M + sw + 26
    tw = inner - sw - 26
    ty = y

    ty = d.wrap(
        tx, ty,
        "More › Sync queue lists every piece of work the handset is holding, newest "
        "first. You never have to take the banner's word for it — this is the actual "
        "list.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 8

    ty = d.text(tx, ty, "Reading it", BOLD, 11.5, NAVY, 20)
    ty = d.bullets(tx, ty, [
        ("An amber clock", "still on the phone, waiting for coverage"),
        ("A green tick", "the office has it; safe to sign out"),
        ("A red warning", "the office refused it — show your manager"),
    ], tw)

    ty -= 6
    ty = d.wrap(
        tx, ty,
        "Order is preserved. A visit created offline is sent before the check-in that "
        "belongs to it, so the two still join up at the office.",
        tw, size=10, colour=MUTED, leading=15,
    )

    ty -= 4
    d.note(
        tx, ty, tw, "Rejected work is kept, not dropped",
        "Something the office cannot accept stays on the list rather than disappearing. "
        "It is a conversation with your manager, not a loss.",
        accent=AMBER,
    )

    y = y - sh - 26
    sw2, sh2 = d.shot("22-offline-pending.png", M, y, 132, 236)
    tx = M + sw2 + 26
    tw = inner - sw2 - 26
    ty = y
    ty = d.text(tx, ty, "The count follows you", BOLD, 12, NAVY, 20)
    d.wrap(
        tx, ty,
        "The moment you save anything without a signal, the banner and the Sync line "
        "change to say how many items are held. They go back to a green tick on their own "
        "once coverage returns and the queue drains — you do not have to do anything.",
        tw, size=10, colour=MUTED, leading=15,
    )
    d.end()

    # ══ the rest of the app ═══════════════════════════════════════════════
    d.section = "The More tab"
    y = d.header("Everything else", "The More tab")

    sw, sh = d.shot("17-more-full.png", M, y, 190, 408)
    tx = M + sw + 28
    tw = inner - sw - 28
    ty = y

    ty = d.wrap(
        tx, ty,
        "One screen for the things you need occasionally rather than at every stop.",
        tw, size=10.5, colour=INK, leading=16,
    )
    ty -= 8

    ty = d.text(tx, ty, "Sync", BOLD, 11.5, NAVY, 20)
    ty = d.bullets(tx, ty, [
        ("Status", "synced, or how many items are waiting, with the last send time"),
        ("Sync queue", "the full list of what is held"),
    ], tw)

    ty = d.text(tx, ty, "Field", BOLD, 11.5, NAVY, 20)
    ty = d.bullets(tx, ty, [
        ("Awaiting KRA", "sales still to be filed; only if your company files"),
        ("Expense claim", "fuel, airtime, travel"),
        ("Location tracking", "your route in the background, so the office can see coverage"),
    ], tw)

    ty = d.text(tx, ty, "Subscription", BOLD, 11.5, NAVY, 20)
    ty = d.wrap(
        tx, ty,
        "What your company pays for. A feature missing from this list is switched off for "
        "everyone at your company, not broken on your handset — which is the answer to "
        "most “why can I not see this?” questions.",
        tw, size=10, colour=MUTED, leading=15,
    )

    y = y - sh - 28
    y = d.text(M, y, "Location tracking, plainly", BOLD, 12.5, NAVY, 22)
    y = d.wrap(
        M, y,
        "While the switch is on, the app records where you go during the working day and "
        "sends it with everything else. It is there so the office can see route coverage "
        "and settle a disputed visit, and it is the same trail that proves you were at a "
        "shop when a check-in could not be verified. Your manager can tell you your "
        "company’s policy on switching it off.",
        inner, size=10.5, colour=MUTED, leading=16,
    )
    d.end()

    # ══ back page ═════════════════════════════════════════════════════════
    c.setFillColor(NAVY_DEEP)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(CYAN)
    c.rect(0, H * 0.70, W, 4, stroke=0, fill=1)
    c.setFillColor(TEAL)
    c.rect(0, H * 0.70 - 4, W * 0.45, 4, stroke=0, fill=1)

    if logo.exists():
        im = Image.open(logo)
        w = 170
        h = im.height * (w / im.width)
        pad = 20
        c.setFillColor(WHITE)
        c.roundRect(M - pad, H * 0.77 - pad, w + pad * 2, h + pad * 2, 10, stroke=0, fill=1)
        c.drawImage(ImageReader(str(logo)), M, H * 0.77, w, h, mask="auto")

    y = H * 0.60
    c.setFont(BOLD, 18)
    c.setFillColor(WHITE)
    c.drawString(M, y, "Need a hand?")
    c.setFont(BODY, 10.5)
    c.setFillColor(HexColor("#B9C9D8"))
    y -= 28
    for line in [
        "Ask your branch manager first. Most questions turn out to be about",
        "what your role is allowed to do, and they can change that.",
        "",
        "For anything else, the office can reach support at",
        "phinetechltd@gmail.com.",
    ]:
        c.drawString(M, y, line)
        y -= 16

    c.setFillColor(HexColor("#6E8296"))
    c.setFont(BODY, 9)
    c.drawString(M, 92, "Tari Africa Platforms Limited  ·  Nairobi, Kenya")
    c.drawString(M, 78, f"Raut Field Sales 1.2  ·  {dt.date.today():%B %Y}")
    c.showPage()

    d.save()
    return OUT


if __name__ == "__main__":
    p = build()
    print(f"{p.name}  {p.stat().st_size / 1024:.0f}KB")
