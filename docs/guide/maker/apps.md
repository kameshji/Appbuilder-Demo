# Apps

An app is a set of screens with controls, formulas and links to tables. Apps are listed on the **Apps** page.

![Apps page](../../images/portal-apps.png)

## Create an app

- **New blank app**: choose a design resolution (Full HD 1920x1080, 2K 2560x1440, or Custom, minimum 640x360 with width at least height) and a scaling mode (Responsive, or Fit, which letterboxes).
- **Start with data**: on Home, pick a table. Appbuilder creates "<Table> app" with a table control and an edit form already connected, and adds the data source.

![Start with data](../../images/home-start-with-data.png)

A table control with an empty **Columns** property shows every column, including system ones (id, createdOn and so on). Set **Columns** to the ones you want.

## Open, run, rename, duplicate, delete

Use the menu on an app's row:

- **Edit** opens the Studio.
- **Run** opens the app in its own window.
- **Rename**, **Duplicate**.
- **Export package** (see below).
- **Add to solution** (see [Solutions](solutions.md)).
- **Delete**. Tables the app used are not deleted.

## Export and import packages

An app package is a YAML file (`kind: appbuilder/app`). On the app menu choose **Export package**. A toggle lets you include table rows. In the Studio, the "..." menu has **Export package** and **Import package**; importing from the Studio always creates a new app and opens it, never overwriting.

## Run window and hot reload

**Run** opens a 1600x900 pop-up. If your browser blocks pop-ups, the app opens in the current page instead. In the Studio, **Preview** runs the app in place (press `Esc` to leave, **Restart** to reset), and the **Run in window** icon opens the pop-up.

While the Studio is open, a run window reloads automatically when you change the app and keeps its current state. It shows a debug bar with Hot restart, a screen picker, size presets (Full HD, 2K, 1366, 21:9) and Trace and errors. Changes save on their own about 0.7 seconds after you stop; the status next to the name reads Saved, Saving, Unsaved or Not saved.

If a user without access runs an app they see "You don't have access to this app. Ask an admin to add the app to one of your security roles."

## App settings

In the Studio, choose **Settings**:

- Name
- Design resolution and Scale mode (Responsive or Fit)
- Theme (Light or Dark), primary colour, corner radius
- **App.OnStart**: a formula that runs when the app opens
- **App.Formulas**: named formulas and your own functions (see [Formulas](formulas.md))
