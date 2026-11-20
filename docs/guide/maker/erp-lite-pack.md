# The ERP-lite pack (stock, purchase, sales)

A ready-made solution for a small trading or manufacturing business: what you have where, what you asked to buy and
who approved it, what you ordered and received, what customers ordered and what you delivered, and a commercial invoice
for what was delivered. It installs from **Templates > Solutions > ERP-lite** like any solution template
([Templates](templates.md)): Linked (upgradable) by default, through the binding step and the plan screen, in one step
that either completes or changes nothing.

**No tax, no accounts.** The pack computes, stores and prints no GST or other tax and keeps no ledgers. Its invoices are
**commercial invoices**, printed with "NOT A TAX INVOICE"; whether you may use such a document is for your accountant
to decide. The HSN or SAC code of an item is a plain text on the item. Tax invoices and ledgers come in a later package,
after an accountant has reviewed the tax rules.

## What it contains

| Part | What |
| --- | --- |
| Shared tables (common business model) | **Products** are the items (code, name, unit, HSN or SAC code, list price); **Accounts** are suppliers and customers (by Type); **Price lists** and **Price list items**. When the CRM pack (or anything else) installed the common business model already, ERP-lite uses those tables: it creates no copies. |
| Tables (14) | **Locations**, **Movement reasons**, **Stock movements**, **Stock on hand**, **Purchase requests** and lines, **Purchase orders** and lines, **Goods receipts**, **Sales orders** and lines, **Deliveries**, **Commercial invoices** and lines. |
| Desktop apps (3) | **Purchase** (requests and sending them for approval, orders, suppliers, price lists; prints), **Stores** (stock on hand, movements, goods receipts, deliveries, locations, reasons; prints the GRN and the delivery challan), **Sales** (sales orders, deliveries, invoices, customers; prints the challan and the invoice). |
| Phone app (1) | **Stores on the phone**: scan an item's barcode or QR code (or type its code), see its stock per location, **Receive**, **Issue**, **Count**. Works offline (entry). The location is the one you are in charge of (Locations > In charge). |
| Flows (10, arrive off) | Purchase request approval; Turn an approved request into a purchase order; Purchase order approval above Rs 50,000; Purchase order receipt status; Sales order delivery status; Complete a transfer; Reorder alert; Delivery notification; Commercial invoice for a delivery; Overdue purchase order reminder (09:30 India time, Monday to Saturday). |
| Approval policies (2) | Purchase request approval and Purchase order approval: a person with the Manager role, never the person who raised the request or order. |
| Dashboards (2) | **Stock** (stock value at list price, items below their reorder level, value by location, the list below reorder level), **Orders and movements** (open purchase orders, sales orders to deliver, orders by status, receipt and delivery lines by week). |
| Print templates (5) | Purchase request (the built-in one), Purchase order, Goods receipt note, Delivery challan (the built-in one), Commercial invoice (not a tax invoice). |
| Roles (6) | Requester, Purchase, Stores, Sales, Accounts (read), Manager (who sees what: below). |
| Number sequences (6) | `PR/2026-27/0001`, `PO/...`, `GRN/...`, `SO/...`, `DC/...`, `CI/...`: they restart every financial year (April to March). |
| Reference rows | 11 movement reasons (purchase receipt, customer return, issue to production, sales delivery, damaged, stock count ...). |
| SAMPLE rows (optional) | Two locations and one of each document of a fictional company, without lines. Items, suppliers and customers live in the shared tables, where a pack never puts SAMPLE rows: add a few items to see stock move. **Remove sample data** deletes exactly these rows (a SAMPLE location your stock still points at stays, and the page says so). |

## How stock works

Every change of stock is a **stock movement** with a signed quantity: receipts and transfers in add, issues and
transfers out take (type the quantity; the sign follows the kind), an adjustment corrects, a count books the difference
between what you counted and the stock. A **goods receipt line** and a **delivery line** are stock movements too (with
the receipt or delivery and the order line filled in): that is what makes stock exact.

**Stock on hand** is kept by the platform from the movements, per item and location, in the same step as each movement.
It never goes below zero: a movement that would is refused at once, in plain words, for example *Stock of Hex bolt M10
at Main store would go below zero: available 25, requested 30.* This holds when many people issue at the same time. You
cannot type a stock figure; you can set the **reorder level**, reorder quantity and bin on each stock row. When the
stock of an item at a location falls below its reorder level, the Purchase role is told.

**Offline on the phone**: a movement saved without a connection waits on the phone. When the connection returns it is
sent; if the stock is no longer enough, the server refuses it and it stays in the phone's outbox with that message
(**waiting to send > needs you**): fix the quantity and send it again, or discard it.

**Stock value at list price** is the value of each movement at the item's list price when it was recorded (the sum of
quantity times that price).

## The purchase and sales cycles

1. A **requester** raises a purchase request with its lines and sends it for approval; a **manager** approves it (never
   the requester). The approved request becomes a **draft purchase order** to the preferred supplier with the same lines.
2. **Purchase** checks the order and sends it for approval: up to Rs 50,000 (before tax) it is approved at once, above
   that a manager approves it.
3. **Stores** receive against the approved order in one or more **goods receipts**; each line raises the stock. The
   order becomes **Partly received**, then **Received**. A receipt beyond the ordered quantity is refused.
4. **Sales** enters a sales order; the line's price comes from the order's price list (else the item's list price).
5. **Stores** make a **delivery** (printed as a delivery challan) with its lines; a line beyond the stock, or beyond what
   the customer ordered, is refused. **Dispatched** tells the owner of the sales order; **Delivered** creates a draft
   commercial invoice at the sales order's prices, which belongs to the owner of the sales order.

## Who sees what

| Role | Sees | Changes |
| --- | --- | --- |
| Requester | their own purchase requests; items, locations; stock | their own requests and lines |
| Purchase | all requests, orders and lines, suppliers, price lists, receipts, movements, stock | orders and lines, suppliers, price lists, items |
| Stores | movements, stock, receipts, deliveries, locations, reasons; orders and sales orders (purchase **rates and amounts hidden**) | movements (their own after saving), reorder levels, receipts, deliveries, locations |
| Sales | **their own** sales orders and invoices; deliveries; stock | their own sales orders, lines, invoices |
| Accounts (read) | every document and the stock | nothing |
| Manager | everything of the pack | everything of the pack; approves requests and orders |

Nobody, an administrator included, types into the stock on hand: it follows the movements. Assigning people to roles
is a manual step after the install (Admin console > Users).

## Upgrades and uninstall

Upgrades keep your changes by default (see [Templates](templates.md)); your data rows are never changed. Uninstall
removes the apps, flows, roles, policies, dashboards and print templates; tables with data are kept unless an
administrator ticks **Delete tables with data**; the shared business model tables are never touched.
