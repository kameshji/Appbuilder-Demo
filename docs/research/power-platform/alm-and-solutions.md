# ALM and solutions

Research date: 18 November 2026. Sources are Microsoft Learn pages retrieved on that date. Opinions are labelled *inference*; unconfirmed claims are labelled *unverified*.

## 1. What a solution is

Solutions are Microsoft's mechanism for application lifecycle management in Power Apps and Power Automate: a container of **components** (tables, columns, forms, views, apps, flows, agents, security roles, environment variables, connection references, plug-ins, web resources, site maps...) that can be exported from one environment and imported into another ([solution concepts](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm)). A solution file can be up to 95 MB. Components nest (a table contains forms, views, columns, relationships, business rules), and there are roughly twice as many component types as appear in the UI because most are nested ([solution components](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#managed-and-unmanaged-solutions)).

Every environment also has two system solutions, the *Default Solution* and the *Common Data Service Default Solution*; work done outside a custom solution lands there. A maker can set a **preferred solution** so new components go into it automatically ([solution publisher section](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#solution-publisher)).

## 2. Managed vs unmanaged

| | Unmanaged | Managed |
|---|---|---|
| Purpose | Development; the source | Deployment; a build artifact |
| Where | Development environments | Test, UAT, production |
| Editable | Yes | No; to change a managed component you customise it in an unmanaged layer on top (which creates a dependency) |
| Export | As unmanaged or as managed | Cannot be exported |
| Delete | Removes only the container; customisations stay in the default solution | Uninstall removes all its components **and the data in its custom tables and custom columns** |
| Same environment | — | Cannot be imported into the environment that holds the originating unmanaged solution |

Source: [solution concepts](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm). **Managed properties** let a publisher prevent downstream customisation of specific components (for example whether auditing can be toggled) ([configure auditing, managed properties](https://learn.microsoft.com/power-apps/developer/data-platform/auditing/configure#configure-tables-and-columns)).

## 3. Layers

Each component in an environment has a **stack of layers** ([solution layers](https://learn.microsoft.com/power-platform/alm/solution-layers-alm#layering-within-a-managed-solution)):

```
  Unmanaged (Active) layer      <- any direct customisation in this environment
  Managed solution C (top)      <- patches / pending upgrade stack within a solution
  Managed solution B
  Managed solution A (base)     <- first publisher that introduced the component
  System layer
```

- Behaviour is **"top wins"** for almost all components: the topmost layer defines runtime behaviour.
- Only **model-driven apps, forms and site maps are merged** across layers.
- Within one managed solution: base, then patches stacked in order, then a pending (staged) upgrade named `_Upgrade`.
- A known consequence: importing a new version of a managed solution doesn't take effect if someone made an **unmanaged change on top** in the target. Fix by removing the active layer or importing with **Overwrite customizations**, which copies the incoming value into the active layer ([changes not effective after import](https://learn.microsoft.com/troubleshoot/power-platform/dataverse/working-with-solutions/changes-not-effective-solution-import#cause-1-unmanaged-active-customization-on-top)).

## 4. Publishers and prefixes

Every solution has a publisher with a **customisation prefix** (for example `contoso_`) prepended to schema names to avoid collisions. The publisher that creates a component owns it and controls what others may change; ownership can move between solutions of the same publisher but **not across publishers**, and the prefix of created items can't be changed afterwards ([solution publisher](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#solution-publisher)). Microsoft recommends one publisher per organisation.

## 5. Lifecycle operations

From [solution lifecycle](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#solution-lifecycle):

| Operation | Effect |
|---|---|
| Create / export | Author an unmanaged solution, export unmanaged or managed |
| Update | Import a newer version over a managed solution; adds/changes components, **cannot delete** components |
| Upgrade | Import as upgrade: rolls up patches into the new version and **deletes components no longer included**; can be immediate or **staged** ("stage for upgrade", then "apply upgrade") |
| Patch | Only changes for a parent managed solution, layered on top; cannot delete components. **Microsoft no longer recommends patches** ([layers](https://learn.microsoft.com/power-platform/alm/solution-layers-alm#layering-within-a-managed-solution)); rolling patches up requires `CloneAsSolution` (unmanaged) or import + `DeleteAndPromote` (managed) ([patches](https://learn.microsoft.com/power-platform/alm/create-patches-simplify-solution-updates#update-a-solution)) |

Versioning is `major.minor.build.revision`; by default only higher versions can be imported.

## 6. Dependencies

Two kinds ([solution dependencies](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#solution-dependencies)):

- **Solution dependencies**: a managed solution that customises components from another can't be installed before it, and the base can't be uninstalled while the dependent is present.
- **Component dependencies**: a column depends on its table, a view on its columns, a flow on a connection reference, a canvas app on its offline profile. Missing dependencies block import (a solution's `missingdependencies.yml` in source control lists them). Makers use "Add required objects" and "Show dependencies" to manage them ([offline export](https://learn.microsoft.com/power-apps/mobile/canvas-mobile-offline-setup#using-the-offline-template-and-offline-status-icon), [env var FAQ](https://learn.microsoft.com/power-apps/maker/data-platform/environment-variables-faq)).

## 7. Environment variables and connection references in solutions

Both exist so a solution can move between environments without editing its components:

- **Environment variables**: definition (+ default value) travels in the solution; the **current value** is per environment and can be removed before export so the importer is prompted. Values are stored in separate JSON files in the exported zip, and build tools accept a *deployment settings file* to supply values automatically ([env vars](https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables#how-do-environment-variables-work), [naming and limits](https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables#naming)). In a managed solution the value is visible only through the Default solution, because it's an unmanaged customisation ([FAQ](https://learn.microsoft.com/power-apps/maker/data-platform/environment-variables-faq)).
- **Connection references**: solution flows bind every connector action to a reference; on import the importer maps each reference to a connection, and flows can then turn on automatically ([connection references](https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference)). Canvas apps use references only for implicitly shared connections.

## 8. Pipelines

**Pipelines in Power Platform** are an in-product deployment tool ([pipelines FAQ](https://learn.microsoft.com/power-platform/alm/pipelines#frequently-asked-questions)):

- A **host environment** stores pipeline configuration and run history (Dataverse tables of the "Deployment Pipeline Configuration" app). Development and target environments are linked to a host; an environment can belong to only one host; the host must not also be the dev environment.
- A pipeline has stages (for example Test → Production). A maker starts a deployment from the unmanaged solution in the dev environment; the pipeline exports managed (and keeps the unmanaged export in the host), prompts for environment variable values and connection references, runs validation, and imports into the target.
- Import behaviour is always **Upgrade without Overwrite customizations**; you can't choose update vs upgrade. Deploying unmanaged solutions isn't supported. One solution per deployment. Rollback = redeploy a previous version if the setting is on; otherwise download the artifact, bump the version in `solution.xml`, import manually.
- Extension points via Dataverse business events let admins add approvals, service-principal deployments, and DevOps integration ([extend pipelines](https://learn.microsoft.com/power-platform/alm/extend-pipelines)).
- Cross-geo deployments need an explicit host setting.
- A default deployment pipeline can be enforced through an environment group rule ([rules](https://learn.microsoft.com/power-platform/admin/environment-groups-rules)).

## 9. Source control

Three generations:

1. **SolutionPackager** (`SolutionPackager.exe`, now `pac solution unpack/pack`): reversibly decomposes a solution zip into many XML files (`Other/Solution.xml`, `Other/Customizations.xml`, entity folders, workflows...) for Git ([SolutionPackager](https://learn.microsoft.com/power-platform/alm/solution-packager-tool)).
2. **YAML source control format**: `solutions/<name>/solution.yml`, `solutioncomponents.yml`, `rootcomponents.yml`, `missingdependencies.yml`, `publishers/<name>/publisher.yml`, and component folders (`entities/`, `workflows/`, `canvasapps/`...). Smaller diffs, multiple solutions per repo, and the only format that supports canvas `.msapp` and modern flows. Requires CLI 2.4.1+; auto-detected by the presence of `solutions/` ([source control file formats](https://learn.microsoft.com/power-platform/alm/use-source-control-solution-files#source-control-file-formats), [pac solution](https://learn.microsoft.com/power-platform/developer/cli/reference/solution#pac-solution-unpack)).
3. **Native Dataverse Git integration**: connect an environment or solution to an Azure DevOps or GitHub repo from the solution UI, commit and pull changes in YAML. It is a **managed environments** feature, needs Azure DevOps licences for committers, is intended for **development environments only**, and doesn't support cross-tenant ([Git integration overview](https://learn.microsoft.com/power-platform/alm/git-integration/overview), [connect to Azure DevOps](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-azure-devops), [FAQ](https://learn.microsoft.com/power-platform/alm/git-integration/faqs#how-can-i-upgrade-existing-solutions)). Canvas apps commit only on publish, as `.pa.yaml` ([canvas Git](https://learn.microsoft.com/power-platform/alm/git-integration/canvas-apps-git-integration)).

Microsoft's enterprise reference architecture combines these: several dev environments each mapped to a Git branch, PR review into main, pipelines promoting to Test → UAT → Production, a hotfix environment on a release branch, and a Copilot agent that writes release notes from Azure Boards work items ([enterprise ALM architecture](https://learn.microsoft.com/power-platform/architecture/reference-architectures/enterprise-power-platform-alm#workflow)).

## 10. The file format at a high level

A solution `.zip` contains:

| File | Content |
|---|---|
| `solution.xml` | Unique name, version, publisher (name, prefix), managed flag, root components list, missing dependencies |
| `customizations.xml` | Table/column/relationship metadata, forms (FormXml), views (FetchXML + layout), site maps, option sets, security roles, ribbon definitions, most other metadata in one large XML |
| `[Content_Types].xml` | OPC package content types |
| Folders | `Workflows/` (flow and classic workflow definitions as JSON/XAML), `CanvasApps/` (`.msapp` + metadata), `WebResources/`, `PluginAssemblies/`, `environmentvariabledefinitions/` (with values as JSON), connection references, bots/agents, etc. |

(Folder names in this table follow the XML-format unpack layout described on the SolutionPackager and pac pages; the exact zip inner names other than `solution.xml`/`customizations.xml` are *unverified*.)

## How to replicate on our stack (single Node server + MySQL)

### Where we are

`ab_solutions(id, name, display_name, publisher, version, components)` with component kinds app, table, role, connection, file. Export is a YAML package (`kind: appbuilder/solution`, `packageVersion: 1`); **import always creates new instances, never overwrites** (data-api.md, architecture.md). That's fine for templates but not for ALM: you can't ship v1.1 of "QC Inspection" to production and keep its data.

### Proposal: one kind of solution, upgrade in place, no layers

**Identity.** Every component gets a stable `uid` (`sol:<solution-name>/<kind>/<name>`) recorded on install. Re-importing a solution with the same `name` is an **upgrade**: components are matched by `uid`, not by display name.

**Install record.**

```sql
ab_solution_installs(solution_name, version, installed_on, installed_by, source_env, package_hash, mode ENUM('editable','locked'))
ab_solution_component_map(solution_name, kind, uid, local_id, hash_at_install)
```

`mode='locked'` is our "managed": components can't be edited in Studio in that environment, which is what production should be. `editable` is "unmanaged". There are **no layers**: one current definition per component.

**Upgrade algorithm** (all in one MySQL transaction where possible; DDL in MySQL auto-commits, so do schema changes first with a pre-check, then metadata):

1. Parse the package, validate `packageVersion`, check `version` > installed version (or `--allow-downgrade` for admins).
2. **Plan**: for each component compute `add | change | unchanged | remove`. For tables compute a **schema diff** (columns added, type changes, columns removed). For locally edited components (`hash != hash_at_install`) mark **conflict**.
3. Show the plan in the import wizard: environment variable values to fill, connection references to map, conflicts (choose "keep local" or "take incoming"), and **destructive changes** (dropping a column with data) which require typing the table name to confirm. Removing a table in an upgrade never drops data by default; it detaches the table from the solution.
4. Back up first (automatic `mysqldump` of the environment schema; see `admin-and-environments.md`).
5. Apply: DDL via the MySQL connector's `addColumn`/`alterColumn` (values are already verified to convert per the connector contract), metadata rows, apps (new app version, published), flows (disabled during apply, re-enabled after), roles.
6. Record new `hash_at_install`, write `ab_audit` entry `solution.upgrade` with the plan.

**Dependencies.** Solutions list `requires: [{ solution, minVersion }]`; components list references they need (table names used by an app's `dataSources`, connection refs, env vars). Export computes and embeds the closure; import refuses with a precise message when something is missing. Our app definition already declares `dataSources`, so app → table dependency is free.

**Publisher prefix.** Skip it. Table and column names are scoped to the environment and already unique; conflicts are reported at plan time. Prefixes help ISVs shipping into shared tenants — not our market.

**Patches.** Skip. Versions are cheap.

**Environment variables and connection references.** As in `admin-and-environments.md` and `connectors.md`: definitions in the solution, values per environment, prompted at import, scriptable by a `settings.yaml` file for repeatable deployments.

**Pipelines (lite).** In the admin console: "Deploy solution X from Development to Production" = export from env A, run the import plan against env B, show the plan, apply, record in `ab_deployments(id, solution, version, from_env, to_env, plan_json, status, by, at)`. **Rollback** = restore the pre-deployment backup of env B (and re-import the previous version for metadata-only rollbacks). Because both environments live on the same server, this is an in-process operation — no host environment, no export/import across tenants.

**Source control.** Our packages are already YAML. Change the export layout to a **folder format** for Git (one file per component, stable key order, no timestamps):

```
solution.yaml                # name, version, requires, components index
tables/QcInspection.yaml     # TableDef + views + form metadata
apps/QcInspection/app.yaml   # app props, theme, dataSources
apps/QcInspection/screens/Home.yaml
flows/NotifyOnFail.yaml
roles/Inspector.yaml
envvars.yaml                 # definitions + defaults (no values)
connrefs.yaml
```

and a single-file `.absol` (zip of that folder) for e-mailing to a customer. A CLI (`node server/cli.ts solution export|import|plan --env`) makes CI possible for the few customers who want Git; the rest never need to know.

## Where we can be better for a 20-50 person org

| Microsoft pain point | Evidence | Better design |
|---|---|---|
| Layers with "top wins", merge only for some components, unmanaged changes on top silently hiding upgrades | [Solution layers](https://learn.microsoft.com/power-platform/alm/solution-layers-alm#layering-within-a-managed-solution), [changes not effective](https://learn.microsoft.com/troubleshoot/power-platform/dataverse/working-with-solutions/changes-not-effective-solution-import#cause-1-unmanaged-active-customization-on-top) | No layers. One definition per component; conflicts shown at import with an explicit choice. |
| Uninstalling a managed solution deletes data in its tables and columns | [Solution concepts](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm) | Uninstall detaches metadata; dropping data is a separate, confirmed action with a backup. |
| Update vs upgrade vs patch vs staged upgrade; patches no longer recommended but still there | [Lifecycle](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#solution-lifecycle), [patches](https://learn.microsoft.com/power-platform/alm/create-patches-simplify-solution-updates#update-a-solution) | One operation: upgrade with a previewed plan. |
| Publisher ownership and prefixes that can't be changed later | [Publisher](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#solution-publisher) | No prefixes; name conflicts reported at plan time. |
| Pipelines need a host environment, one solution per run, fixed import mode, rollback by editing `solution.xml` | [Pipelines FAQ](https://learn.microsoft.com/power-platform/alm/pipelines#frequently-asked-questions) | In-process deploy between environments on the same server, rollback by restoring the automatic pre-deploy backup. |
| Git integration only for managed environments and needs Azure DevOps licences | [Connect to Azure DevOps](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-azure-devops) | Folder-format export any Git host can store; optional. |
| Three source formats over time (XML, YAML, `.msapp`/`.pa.yaml`) | [Source control formats](https://learn.microsoft.com/power-platform/alm/use-source-control-solution-files#source-control-file-formats) | One YAML format from the start; `packageVersion` migrations handled by the server. |
| Work outside a solution lands in a Default solution and must be moved | [Publisher section](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#solution-publisher) | Every app/table optionally belongs to a solution; "Add to solution" with automatic dependency closure. |

**Not worth replicating**: managed properties, segmented solutions, solution checker as a separate service (fold its useful rules into the App checker), multiple publishers, staged upgrades, cloning as solution, the Default/CDS Default solution split, OPC zip packaging, SolutionPackager mapping files.

**Worth copying**: managed (locked) vs unmanaged (editable) as a per-environment mode, stable component identity, dependency tracking with "add required objects", env var + connection reference prompts on import, deployment history per environment, the idea that production should be locked against ad-hoc edits.

**Honest caveat for the pilot**: a 30-person manufacturer will likely run *one* production environment and maybe one test copy. The minimum viable ALM is: (1) upgrade-in-place import with a plan preview, (2) automatic backup before apply, (3) lock production apps from editing unless an admin unlocks. Build those three first; Git folders and multi-stage deploys can wait.

## Sources

- [Solution concepts](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm)
- [Solution layers](https://learn.microsoft.com/power-platform/alm/solution-layers-alm)
- [Create patches to simplify solution updates](https://learn.microsoft.com/power-platform/alm/create-patches-simplify-solution-updates)
- [Changes aren't effective after solution import](https://learn.microsoft.com/troubleshoot/power-platform/dataverse/working-with-solutions/changes-not-effective-solution-import)
- [Configure auditing (managed properties)](https://learn.microsoft.com/power-apps/developer/data-platform/auditing/configure)
- [Environment variables overview](https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables)
- [Environment variables FAQ](https://learn.microsoft.com/power-apps/maker/data-platform/environment-variables-faq)
- [Use a connection reference in a solution](https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference)
- [Set up mobile offline (export with dependencies)](https://learn.microsoft.com/power-apps/mobile/canvas-mobile-offline-setup)
- [Overview of pipelines in Power Platform](https://learn.microsoft.com/power-platform/alm/pipelines)
- [Extend pipelines](https://learn.microsoft.com/power-platform/alm/extend-pipelines)
- [Rules for environment groups](https://learn.microsoft.com/power-platform/admin/environment-groups-rules)
- [SolutionPackager tool](https://learn.microsoft.com/power-platform/alm/solution-packager-tool)
- [Source control with solution files](https://learn.microsoft.com/power-platform/alm/use-source-control-solution-files)
- [pac solution reference](https://learn.microsoft.com/power-platform/developer/cli/reference/solution)
- [Overview of Git integration](https://learn.microsoft.com/power-platform/alm/git-integration/overview)
- [Connect to Azure DevOps](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-azure-devops)
- [Git integration FAQs](https://learn.microsoft.com/power-platform/alm/git-integration/faqs)
- [Source control for canvas apps](https://learn.microsoft.com/power-platform/alm/git-integration/canvas-apps-git-integration)
- [Enterprise ALM reference architecture](https://learn.microsoft.com/power-platform/architecture/reference-architectures/enterprise-power-platform-alm)
