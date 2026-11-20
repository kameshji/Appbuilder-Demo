# Templates

Templates are ready-made parts you add to your environment: **UI components** (for example an approval bar), **screens**
(for example a list with a form), whole **apps** (a request tracker) and **data models** (customers, contacts and
activities). Using a template **never overwrites anything you have**: you choose which of your tables it works on, you
see the plan of what will be added, and it is installed in one step that either completes or changes nothing.

Open **Templates** in Dev mode (Maker role). The catalogue ships with Appbuilder and works offline.

## The catalogue

Filter by kind (UI components, screens, apps, data models) or search. Choose a template to see:

- **What it contains**: how many UI components, screens, tables, relationships, rules and SAMPLE rows;
- **What it needs**: the tables and columns it works on (its *data slots*), with the column types each accepts and
  whether a column is required;
- whether it is **verified** (built-in templates are checked against the list of templates that ships with this release;
  a template that was changed is shown as damaged and cannot be used), and the oldest Appbuilder version it runs on;
- whether it can be used as a **Copy** only, or also **Linked** (see below).

## Use a template

**Use** starts two steps.

### 1. The data it works on (binding)

For every table the template needs you choose:

- **Use one of my tables**: pick the table, then for each column the template needs, the column of your table. Columns
  of a type that does not fit are marked, and the reason is given in words (for example *"Points" is a whole number
  column; Status needs a choice or text column*). A **required** column must be mapped; an optional one may stay
  unmapped (what the template shows from it stays blank).
- **Create a new table**: the template creates it, with its columns, under the name you give.
- **Leave out** (optional tables only).

**Name clashes** are resolved here, before anything is installed: when a table of the same name exists, the slot shows
two buttons, **Use <table>** (map the slot to it) or **Install as <new name>**. An app template whose app name is taken
asks for another name (with a suggestion). Your table, your app, your roles are never replaced.

Templates refer to their tables through these slots; when you bind them, every formula inside the template is rewritten
to your table and column names through the formula parser (never a text search and replace).

### 2. The plan

**Review plan** shows the same plan screen as a solution import: what is **new** (tables, the app, roles, rules), what is
**changed** (only the app you are editing, for UI components and screens), and that **nothing is removed**. Problems
(an unmapped required column, a clash still open, a locked environment) are listed in red and **Install** stays
disabled. The plan also says whether a backup of the environment is taken first (it is, when backups are set up).

**Install** runs the plan in one transaction: if anything fails, nothing changes.

## What "use" does, per kind

| Kind | Where you start | What happens |
| --- | --- | --- |
| UI component | Studio, **Insert** pane > **UI components from a template** (or Templates page > Use > choose the app) | a copy of the UI components is inserted into the current screen; names already used in the app get a number (ApprovalBar2); Undo takes it out |
| Screen | Studio, the **template** button next to **+** under the screens (or Templates page > Use) | added as a new last screen of the app you are editing |
| App | Templates page > Use | a new app (and, when an administrator installs it, the roles the template defines; for makers the roles are skipped and the plan says so) |
| Data model | Templates page > Use | the tables, their relationships and rules are created through the same plan and apply as the data model designer; tick **Add the SAMPLE rows** to load example rows, each marked SAMPLE |

SAMPLE rows go only into tables the template creates, and only when it creates all of them: they are never written into
your own tables.

Your existing roles get the usual access to new tables (makers full access, viewers read, others none), as when you
create a table yourself. Nothing they already have changes.

## Copy and Linked

- **Copy** (every kind): the result is yours to edit; it gets no updates from the template.
- **Linked** (app and data model templates only): the template is installed as a versioned **solution** of its own. When
  a newer version of the template arrives with an Appbuilder update, the installed list offers **Upgrade**: the
  upgrade plan of a solution (new and changed columns, the app replaced). If you changed the app or a table since the
  template delivered it, the plan lists those **local changes**; for each you choose **Keep my changes** (the default) or
  **Replace with the new version**. Upgrading in place needs an administrator, like any solution upgrade.
  A template is installed Linked at most once per environment.

UI component and screen templates have no Linked mode: they become part of your app. The Studio does not offer it.

## Sandbox first, then Deploy

A template is installed into the environment you are in. A **locked production environment refuses installs**: install
in a sandbox, check the result, then move it with the solution's **Deploy to** (Linked installs already are a solution;
for a copy, add its app and tables to a solution). See [Solutions](solutions.md).

## Installed templates and uninstall

The Templates page lists what was used in this environment: when, which version, Copy or Linked, what it created or
mapped. App and data model templates can be **uninstalled**:

- the apps, flows and roles the template created are deleted (people who held a role lose it);
- tables it created that are **empty** are deleted; tables **with data stay**, unless an administrator ticks **Also
  delete the tables with data** and types the template's name to confirm;
- tables that other tables point at, or that apps the template did not create use, are always kept (the plan says why);
- your own tables that you mapped are never touched.

A backup is taken first when backups are set up. UI components and screens are removed in the Studio like any other
UI component.

## Rules that protect you

- Templates never bring passwords, keys, connections or people: if a package carries any, they are removed and the plan
  says so.
- Table events that **run as the system** (ignoring row and column security) can only be installed by an administrator,
  who must tick the approval on the plan screen; it is recorded in the audit log.
- Every install, uninstall and upgrade is in the audit log (`template.install`, `template.uninstall`, `template.upgrade`).

Developers: the package format and the internals are in [docs/dev/templates.md](../../dev/templates.md).
