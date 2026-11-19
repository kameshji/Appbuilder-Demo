import type { FxApi, ControlRegistryApi } from '@/contracts'
import { GENERATED_NOTICE, anchor, cell, code, page, table } from './markdown'

/* ------------------------------------------------------------------------------------------------
 * Hand-maintained parts of the formula reference.
 * Everything that can come from the code (functions, enums) is generated; only the category of each
 * function, the enum notes and the prose live here. When you add a function, add it to CATEGORY_OF.
 * ---------------------------------------------------------------------------------------------- */

export type CategoryId = 'logic' | 'text' | 'math' | 'datetime' | 'table' | 'colour' | 'behaviour' | 'data' | 'context' | 'collab' | 'other'

export const CATEGORIES: { id: CategoryId; title: string; intro: string }[] = [
  { id: 'logic', title: 'Logic and errors', intro: 'Choosing between values, testing for blank, catching errors and converting to true/false.' },
  { id: 'text', title: 'Text', intro: 'Building, searching and changing text. Positions start at 1.' },
  { id: 'math', title: 'Math', intro: 'Numbers, rounding, statistics and trigonometry. Statistics functions accept either a list of values or a table and a formula.' },
  { id: 'datetime', title: 'Date and time', intro: 'Dates are date-and-time values. A date without a time is midnight.' },
  { id: 'table', title: 'Table', intro: 'Functions that read, filter, sort, reshape and group tables. Most of them evaluate a formula once per row (see "Row scope" above).' },
  { id: 'colour', title: 'Colour', intro: 'Building and adjusting colours. See also the Color enum below.' },
  { id: 'behaviour', title: 'Behaviour', intro: 'Functions with side effects. They work only in behaviour properties such as OnSelect and OnChange; anywhere else they are an error.' },
  { id: 'data', title: 'JSON and regular expressions', intro: 'Reading and writing JSON text, and matching text against patterns. Patterns are regular expressions; the Match and MatchOptions enums help build them.' },
  { id: 'context', title: 'Context and environment', intro: 'Facts about the signed-in user, the address the app was opened with, and generated identifiers.' },
  { id: 'collab', title: 'Core data model', intro: 'Comments, activities and mentions of records, settings and unit conversion over the system tables every environment has (docs/guide/maker/core-data-model.md). They delegate like the Filter or LookUp they stand for. The write functions (AddComment, AddActivity, Follow, Tag ...) are listed under Behaviour.' },
  { id: 'other', title: 'Other', intro: 'Functions that are not yet assigned to a category in scripts/docs/formulas.ts.' },
]

/** Function name -> category. Behaviour functions are detected from the engine (kind = behaviour) and need no entry. */
export const CATEGORY_OF: Record<string, CategoryId> = {
  // logic
  If: 'logic', Switch: 'logic', And: 'logic', Or: 'logic', Not: 'logic', IsBlank: 'logic', IsEmpty: 'logic', Blank: 'logic',
  Coalesce: 'logic', IfError: 'logic', IsError: 'logic', IsBlankOrError: 'logic', Error: 'logic', IsNumeric: 'logic',
  Boolean: 'logic', With: 'logic',
  // text
  Concatenate: 'text', Concat: 'text', Char: 'text', UniChar: 'text', EncodeUrl: 'text', PlainText: 'text', EndsWith: 'text',
  StartsWith: 'text', Find: 'text', Left: 'text', Right: 'text', Mid: 'text', Len: 'text', Lower: 'text', Upper: 'text',
  Proper: 'text', Replace: 'text', Substitute: 'text', Trim: 'text', TrimEnds: 'text', Split: 'text', Text: 'text', Value: 'text',
  // math
  Abs: 'math', Average: 'math', Count: 'math', CountA: 'math', Cos: 'math', Sin: 'math', Tan: 'math', Degrees: 'math',
  Radians: 'math', Exp: 'math', Ln: 'math', Log: 'math', Int: 'math', Max: 'math', Min: 'math', Mod: 'math', Pi: 'math',
  Power: 'math', Rand: 'math', RandBetween: 'math', Round: 'math', RoundDown: 'math', RoundUp: 'math', Sqrt: 'math',
  StdevP: 'math', VarP: 'math', Sum: 'math', Trunc: 'math',
  // date and time
  Date: 'datetime', DateAdd: 'datetime', DateDiff: 'datetime', DateTimeValue: 'datetime', DateValue: 'datetime', Day: 'datetime',
  EDate: 'datetime', EOMonth: 'datetime', Hour: 'datetime', IsToday: 'datetime', Minute: 'datetime', Month: 'datetime',
  Now: 'datetime', Second: 'datetime', Time: 'datetime', TimeValue: 'datetime', Today: 'datetime', Weekday: 'datetime',
  WeekNum: 'datetime', Year: 'datetime',
  // table
  AddColumns: 'table', Choices: 'table', CountIf: 'table', CountRows: 'table', Defaults: 'table', Distinct: 'table',
  DropColumns: 'table', Filter: 'table', First: 'table', FirstN: 'table', ForAll: 'table', GroupBy: 'table', Index: 'table',
  Last: 'table', LastN: 'table', LookUp: 'table', RenameColumns: 'table', Search: 'table', Sequence: 'table',
  ShowColumns: 'table', Shuffle: 'table', Sort: 'table', SortByColumns: 'table', Table: 'table', Ungroup: 'table',
  // colour
  ColorFade: 'colour', ColorValue: 'colour', RGBA: 'colour',
  // JSON and regular expressions
  JSON: 'data', ParseJSON: 'data', IsMatch: 'data', Match: 'data', MatchAll: 'data',
  // context
  Language: 'context', User: 'context', Param: 'context', GUID: 'context', SharedWith: 'context', DeletedRows: 'table',
  // core data model (P0-N)
  RecordId: 'collab', Comments: 'collab', Activities: 'collab', MyTasks: 'collab', Mentions: 'collab', Setting: 'collab', Convert: 'collab',
}

/** One-line notes for enums. The "Used by" line is generated from the control registry. */
export const ENUM_NOTES: Record<string, string> = {
  Color: 'Named colours. Each member is a colour value: `=Color.Red`. `Color.Transparent` has zero alpha.',
  DisplayMode: 'Whether a UI component accepts input (Edit), only shows its value (View) or is greyed out (Disabled).',
  SortOrder: 'Direction argument of Sort and SortByColumns.',
  NotificationType: 'Second argument of Notify.',
  FormMode: 'Mode of a Form. NewForm, EditForm and ViewForm switch it.',
  Match: 'Pattern pieces for IsMatch, Match and MatchAll. Join them with `&`: `Match.Letter & Match.Hyphen & Match.Letter`.',
  MatchOptions: 'Options for IsMatch, Match and MatchAll. Join them with `&`: `MatchOptions.Contains & MatchOptions.IgnoreCase`.',
  Icon: 'Names of the built-in icons. The value is the icon name as text, so `Icon.Plus` and `"Plus"` are the same.',
  AnimatedIcon: 'Names of the animated icons. The value is the text `anim:<id>`, which is accepted wherever an icon name is.',
}

/** Enums whose members are not listed in full. */
const ENUM_TRUNCATE: Record<string, number> = { Icon: 30, AnimatedIcon: 30 }
const ICON_PICKER_NOTE =
  'The full list is in the icon picker: select an icon property in the Studio and open the picker. Formulas can use any member.'

/* ------------------------------------------------------------------------------------------------ prose */

const INTRO = `# Formula reference

Formulas are how makers say what an app does. Every property of every UI component holds one, a screen can have an \`OnVisible\`
formula, and the app itself can define named formulas and functions. The language is called Fx. It looks like an Excel
formula and has familiar function names, but it is our own engine, so a few things differ from Power Fx (see
[Differences from Power Fx](#differences-from-power-fx)).

This page is generated from the formula engine and the UI component registry. Do not edit it by hand; run \`npm run docs:gen\`.`

const SYNTAX = `## The basics

- A formula is text that **starts with \`=\`**: \`=Price * Quantity\`, \`="Hello, " & User().FullName\`. Text without the leading \`=\` is not a formula and is reported as an error.
- A formula is calculated again when the values it reads change.
- Function names, enum names and enum members are **case-sensitive** (\`Sum\`, not \`sum\`; the error message suggests the right name). The words \`true\`, \`false\`, \`and\`, \`or\`, \`not\`, \`in\`, \`exactin\` and \`As\` can be written in any case.
- Text goes in double quotes. To put a quote inside text, double it: \`"say ""hi"""\`.
- A name that contains spaces or symbols goes in single quotes: \`'My variable'\`. Double a single quote inside the name.
- Numbers: \`12\`, \`1.5\`, \`1e3\`. A percent sign after a number divides by 100: \`50%\` is \`0.5\`.
- A record is \`{ Name: "Asha", Age: 30 }\`; a table is \`[1, 2, 3]\` or \`Table({ Name: "Asha" }, { Name: "Ben" })\`. Values in a table that are not records become records with one field called \`Value\`. A trailing comma is allowed.
- Read a field with a dot: \`First(Contacts).Name\`. A dot after a table gives a one-column table: \`Contacts.Name\`. Reading a field a record does not have gives blank.
- Arguments are separated by commas and the decimal separator is a point (one locale; see the differences below).

### Value types

| Type | Examples | Notes |
| --- | --- | --- |
| Text | \`"Hello"\` | Compared without regard to case by \`=\`, \`<\` and so on. |
| Number | \`42\`, \`3.14\` | |
| Boolean | \`true\`, \`false\` | |
| Date and time | \`Today()\`, \`Date(2026, 11, 18)\` | Adding a number adds days. Subtracting two dates gives days. |
| Colour | \`Color.Red\`, \`RGBA(79, 70, 229, 1)\` | A colour is CSS colour text such as \`rgba(239, 68, 68, 1)\`. |
| Record | \`{ Name: "Asha" }\` | |
| Table | \`[1, 2, 3]\`, a collection, a data table | |
| Blank | \`Blank()\` | No value. See below. |

### Comments

\`// this is a comment to the end of the line\` and \`/* this one can span lines */\` can be used anywhere between tokens. A block comment without its closing \`*/\` is an error.

### Text with values inside (string interpolation)

Put \`$\` before the opening quote and write formulas inside braces: \`$"Hello {User().FullName}, you have {CountRows(Orders)} orders"\`.
To write a brace, double it: \`{{\` and \`}}\`. To write a quote, double it as usual. The braces must not be empty.`

const OPERATORS = `## Operators

Listed from the tightest binding to the loosest. Operators on the same row are calculated left to right.

| Precedence | Operator | Meaning |
| --- | --- | --- |
| 1 (tightest) | \`.\` | Field of a record or column of a table |
| 1 | \`%\` after a value | Divide by 100 |
| 2 | \`-\` \`+\` \`!\` \`Not\` before a value | Negative, plain, not |
| 3 | \`^\` | Power (so \`-2^2\` is 4, and \`2^3^2\` is 64) |
| 4 | \`*\` \`/\` | Multiply, divide |
| 5 | \`+\` \`-\` | Add, subtract (with dates: add or subtract days) |
| 6 | \`&\` | Join text |
| 7 | \`=\` \`<>\` \`<\` \`>\` \`<=\` \`>=\` \`in\` \`exactin\` | Compare. \`=\` is equality, never assignment. \`in\` is true when a value is in a table or text is inside other text, ignoring case; \`exactin\` respects case |
| 8 | \`&&\` \`And\` | Both are true. The right side is not calculated when the left is false |
| 9 | \`\\|\\|\` \`Or\` | Either is true. The right side is not calculated when the left is true |
| 10 (loosest) | \`;\` | Chain several actions (behaviour properties only) |

Because \`!\` and \`Not\` bind tighter than comparisons, \`!a = b\` means \`(!a) = b\`. Write \`Not(a = b)\` or \`!(a = b)\` for the other reading.`

const BLANK_AND_ERRORS = `## Blank and errors

**Blank.** Blank means "no value". It is what an empty input, a missing field or \`Blank()\` gives. In a calculation a blank is 0 for numbers, empty text for text and false for true/false, so \`Blank() + 1\` is 1 and \`Blank() & "x"\` is \`"x"\`. \`Blank() = 0\`, \`Blank() = ""\` and \`Blank() = false\` are all true. \`IsBlank\` is true for blank and for empty text. In comparisons and sorting a blank counts as 0 or as empty text. Reading a field of a blank value gives blank.

**Converting.** Values are converted when they are used, not when the formula is written. Text that looks like a number can be used as one (\`"5" + 1\` is 6, and \`"5" = 5\` is true); the number reader also accepts \`1,234.5\`, \`12%\` and \`$3\`. Text that is not a number is an error: \`"abc" + 1\` gives "Can't turn the text "abc" into a number".

**Errors.** When a calculation cannot be done (dividing by zero, a number that is not valid, text that is not a number, a bad pattern, a call to \`Error("...")\`) the formula stops and its result is an error with a message and the position in the formula. Errors are not values that travel through a table: the first one stops the formula.
- \`IfError(value, fallback)\` gives the fallback when the value is an error. \`IsError\` and \`IsBlankOrError\` test for one.
- Inside a fallback, \`FirstError.Message\` is the message.
- Some mistakes can never be caught by \`IfError\`: an unknown name or function, the wrong number of arguments, and a behaviour function in a data property. They are always reported.
- When a property's formula fails, the UI component behaves as if the property had its default value,.`

const PROPERTIES = `## Data properties and behaviour properties

A property is either a **data property** or a **behaviour property**.
- Data properties (\`Text\`, \`Fill\`, \`Items\`, \`Visible\`, ...) calculate a value. They must not change anything, so behaviour functions (\`Set\`, \`Patch\`, \`Navigate\`, ...) and \`;\` chaining are errors there: "Behaviour function in a non-behaviour property".
- Behaviour properties (the *events*: \`OnSelect\`, \`OnChange\`, \`OnVisible\`, ...) run when something happens. They may call behaviour functions and may chain several steps with \`;\`:

\`\`\`
=Set(Total, 0); Collect(Cart, { Item: Name }); Navigate(CartScreen)
\`\`\`

The UI components reference marks events with the kind \`action\`. The chain gives the value of its last step. A trailing \`;\` is allowed.`

const ROW_SCOPE = `## Row scope: \`ThisRecord\`, \`As\` and \`ThisItem\`

Functions that take a formula to run for each row (\`Filter\`, \`Sort\`, \`ForAll\`, \`LookUp\`, \`AddColumns\`, \`Sum(table, formula)\`, \`Concat\`, ...) make the fields of the current row available **by name**:

\`\`\`
=Filter(Contacts, Age > 30 && City = "Pune")
\`\`\`

- **Shadowing.** A field name wins over a variable or UI component with the same name. Names of outer rows stay reachable when nothing in the inner row has that name.
- **\`ThisRecord\`** is the whole current row (the innermost one): \`ForAll(Contacts, ThisRecord.Name)\`.
- **\`As\`** names the row so that nested formulas can tell rows apart: \`ForAll(Orders As o, CountRows(Filter(Lines As l, l.OrderId = o.Id)))\`. \`As\` goes after a table argument inside a function call, not on its own.
- **\`ThisItem\`** is the item of a Gallery row. The Gallery supplies it; it is not a function row scope.
- \`With(record, formula)\` makes the fields of one record available by name.`

const NAMED = `## Named formulas and user-defined functions

The app-level \`Formulas\` text can hold several definitions, each ending with \`;\`:

\`\`\`
TaxRate = 0.18;
Gross(net: Number): Number = net * (1 + TaxRate);
\`\`\`

- \`Name = expression;\` defines a named formula: a value that is calculated when first needed and can be used like a variable that nobody can set.
- \`Name(param: Type, ...): ReturnType = expression;\` defines a function. The body is **one expression**. It can use its parameters, the app's names, enums and any function (including other user-defined ones) but not the row fields of the place it is called from. Recursion stops at depth 64.
- A name can be defined only once. A function cannot reuse the name of a built-in function, and no definition can reuse the name of an enum.
- A mistake in one definition is reported without hiding the others.`

const DIFFERENCES = `## Differences from Power Fx

Fx was written from the documented behaviour of Power Fx and is **not compatible** with it: apps cannot be imported from or exported to Power Apps. Things that differ, or that people tend to trip over:

- **No static type checking.** Types are not inferred while you type. Values are converted when a formula runs and a wrong type shows up then, as an error message on that property.
- **Errors stop the formula.** A failing calculation is an error for the whole formula, not a value inside a table. Use \`IfError\` to recover.
- **Division by zero is an error** ("Can't divide by zero"), in \`/\` and in \`Mod\`. So is any result that is not a finite number.
- **\`IfError\` has two forms.** \`IfError(value, fallback)\` and the multi-pair form \`IfError(value1, fallback1, value2, fallback2, ..., default)\`: the first value that fails gives its fallback; the optional last argument is returned when nothing failed. Inside a fallback only \`FirstError.Message\` and \`FirstError.Kind\` (always \`"Custom"\`) exist; there is no \`AllErrors\`.
- **User-defined functions have a single expression as their body** (no \`;\` chaining). See "Named formulas" above.
- **Enum names shadow your own names.** A variable, collection or UI component called \`Size\`, \`Side\`, \`Fit\`, \`Layout\`, \`Icon\`, \`Variant\`, \`Match\`, \`Anchor\`, \`Justify\`, \`Orientation\`, \`Color\`, \`Align\` or any other enum name (see the list of enums below) cannot be reached from a formula: the enum wins. Pick other names. A named formula with an enum's name is rejected.
- **\`;\` chaining works only in behaviour properties.**
- **Text is compared without regard to case** by \`=\`, \`<>\`, \`<\`, \`>\` and \`in\`. Use \`exactin\` for a case-sensitive test.
- **One locale.** Syntax and numbers are always en-US: a point for decimals, a comma between arguments, \`Language()\` is always \`"en-US"\`. The optional language argument of \`DateValue\`, \`DateTimeValue\` and \`TimeValue\` is accepted but has no effect. Number text may contain commas as thousands separators, so \`Value("1,5")\` is 15.
- **String interpolation uses \`$"...{formula}..."\`**; write \`{{\` and \`}}\` for literal braces. See "The basics".
- **\`Patch\` with a record as its first argument** (\`Patch(record, changes)\`) only merges two records and does not touch a data source.
- **Regular expressions use JavaScript syntax.**

Behaviour that matches Power Fx but surprises people:
- \`IsMatch\` must match the **whole text** unless you add \`MatchOptions.Contains\`, \`BeginsWith\` or \`EndsWith\`. \`Match\` and \`MatchAll\` find a match **anywhere** in the text by default.

### Not supported yet
- Static type inference and type annotations on ordinary formulas.
- Pushing filters down to the database (delegation): an app loads up to 5,000 rows of each table, warns when the table is longer, and formulas filter those rows in memory.
- Waiting for the server inside an action formula: \`Patch\`, \`Collect\` and \`Remove\` update the screen at once and the server decides afterwards. If the server refuses, the change is rolled back and an error event is raised, but a step that came after it in the same chain (for example \`Navigate\`) has already run. Forms wait for the server before reporting success.
- Other locales and other list separators.`

/* ------------------------------------------------------------------------------------------------ generator */

export interface Generated {
  text: string
  warnings: string[]
}

function enumUsage(enums: string[], registry: ControlRegistryApi): Map<string, string[]> {
  const used = new Map<string, Set<string>>(enums.map((e) => [e, new Set<string>()]))
  const types = [...registry.list().map((c) => c.type), 'Screen']
  for (const type of types) {
    for (const p of registry.propsOf(type)) {
      for (const f of [p.default, ...(p.options ?? [])]) {
        const m = /^=?\s*([A-Za-z]+)\.[A-Za-z0-9]+\s*$/.exec(f)
        if (m && used.has(m[1]!)) used.get(m[1]!)!.add(`${type}.${p.name}`)
      }
    }
  }
  return new Map([...used].map(([k, v]) => [k, [...v].sort()]))
}

function usageLine(uses: string[]): string {
  if (uses.length === 0) return 'Used by: no built-in property lists it as a default or a choice. It is available in formulas.'
  const controls = new Set(uses.map((u) => u.split('.')[0]!))
  if (uses.length <= 6) return `Used by: ${uses.map((u) => code(u)).join(', ')}.`
  return `Used by: ${uses.length} properties on ${controls.size} UI components (for example ${uses.slice(0, 3).map((u) => code(u)).join(', ')}).`
}

export function buildFormulasPage(fx: FxApi, registry: ControlRegistryApi): Generated {
  const warnings: string[] = []
  // user-defined functions from an earlier test must not leak into the reference
  fx.setUserFunctions([])
  const fns = fx.functions().slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const known = new Set(fns.map((f) => f.name))

  const byCat = new Map<CategoryId, typeof fns>(CATEGORIES.map((c) => [c.id, []]))
  const unmapped: string[] = []
  for (const f of fns) {
    let id: CategoryId
    if (f.kind === 'behaviour') id = 'behaviour'
    else if (CATEGORY_OF[f.name]) id = CATEGORY_OF[f.name]!
    else {
      id = 'other'
      unmapped.push(f.name)
    }
    byCat.get(id)!.push(f)
  }
  if (unmapped.length) {
    warnings.push(`${unmapped.length} function(s) have no category in scripts/docs/formulas.ts (listed under "Other"): ${unmapped.join(', ')}`)
  }
  const stale = Object.keys(CATEGORY_OF).filter((n) => !known.has(n))
  if (stale.length) warnings.push(`CATEGORY_OF names functions that no longer exist: ${stale.join(', ')}`)
  const misfiled = Object.keys(CATEGORY_OF).filter((n) => fns.find((f) => f.name === n)?.kind === 'behaviour')
  if (misfiled.length) warnings.push(`CATEGORY_OF lists behaviour functions (they are always filed under Behaviour): ${misfiled.join(', ')}`)

  const enumMap = fx.enums()
  const enumNames = Object.keys(enumMap).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const usage = enumUsage(enumNames, registry)

  const blocks: string[] = [GENERATED_NOTICE, INTRO, SYNTAX, OPERATORS, BLANK_AND_ERRORS, PROPERTIES, ROW_SCOPE, NAMED]

  // functions
  const shown = CATEGORIES.filter((c) => byCat.get(c.id)!.length > 0)
  const fnLines: string[] = [
    '## Functions',
    `${fns.length} built-in functions. A signature in square brackets means the argument is optional; "..." means more of the same may follow. A function marked as behaviour works only in behaviour properties.`,
    shown.map((c) => `- [${c.title}](#${anchor(c.title)}) (${byCat.get(c.id)!.length})`).join('\n'),
  ]
  blocks.push(fnLines.join('\n\n'))
  for (const c of shown) {
    const rows = byCat.get(c.id)!.map((f) => [code(f.signature), cell(f.summary)])
    blocks.push([`### ${c.title}`, c.intro, table(['Function', 'What it does'], rows)].join('\n\n'))
  }

  // enums
  const enumBlocks: string[] = [
    '## Enums',
    `${enumNames.length} built-in lists of named values, written \`EnumName.Member\`, for example \`Align.Center\` or \`Color.Red\`.`,
  ]
  for (const name of enumNames) {
    const members = enumMap[name]!
    const limit = ENUM_TRUNCATE[name]
    const lines = [`### ${name}`]
    if (ENUM_NOTES[name]) lines.push(ENUM_NOTES[name]!)
    lines.push(usageLine(usage.get(name)!))
    if (limit !== undefined && members.length > limit) {
      lines.push(`${members.length} members. The first ${limit}: ${members.slice(0, limit).map((m) => code(m)).join(', ')}, ...`)
      lines.push(ICON_PICKER_NOTE)
    } else {
      lines.push(`${members.length} members: ${members.map((m) => code(m)).join(', ')}.`)
    }
    enumBlocks.push(lines.join('\n\n'))
  }
  blocks.push(enumBlocks.join('\n\n'))
  blocks.push(DIFFERENCES)

  return { text: page(blocks), warnings }
}
