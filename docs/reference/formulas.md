<!-- GENERATED FILE. Do not edit by hand: change the code (or the hand-written parts in scripts/docs/) and run `npm run docs:gen`. -->

# Formula reference

Formulas are how makers say what an app does. Every property of every control holds one, a screen can have an `OnVisible`
formula, and the app itself can define named formulas and functions. The language is called Fx. It looks like an Excel
formula and has familiar function names, but it is our own engine, so a few things differ from Power Fx (see
[Differences from Power Fx](#differences-from-power-fx)).

This page is generated from the formula engine and the control registry. Do not edit it by hand; run `npm run docs:gen`.

## The basics

- A formula is text that **starts with `=`**: `=Price * Quantity`, `="Hello, " & User().FullName`. Text without the leading `=` is not a formula and is reported as an error.
- A formula is calculated again when the values it reads change.
- Function names, enum names and enum members are **case-sensitive** (`Sum`, not `sum`; the error message suggests the right name). The words `true`, `false`, `and`, `or`, `not`, `in`, `exactin` and `As` can be written in any case.
- Text goes in double quotes. To put a quote inside text, double it: `"say ""hi"""`.
- A name that contains spaces or symbols goes in single quotes: `'My variable'`. Double a single quote inside the name.
- Numbers: `12`, `1.5`, `1e3`. A percent sign after a number divides by 100: `50%` is `0.5`.
- A record is `{ Name: "Asha", Age: 30 }`; a table is `[1, 2, 3]` or `Table({ Name: "Asha" }, { Name: "Ben" })`. Values in a table that are not records become records with one field called `Value`. A trailing comma is allowed.
- Read a field with a dot: `First(Contacts).Name`. A dot after a table gives a one-column table: `Contacts.Name`. Reading a field a record does not have gives blank.
- Arguments are separated by commas and the decimal separator is a point (one locale; see the differences below).

### Value types

| Type | Examples | Notes |
| --- | --- | --- |
| Text | `"Hello"` | Compared without regard to case by `=`, `<` and so on. |
| Number | `42`, `3.14` | |
| Boolean | `true`, `false` | |
| Date and time | `Today()`, `Date(2026, 11, 18)` | Adding a number adds days. Subtracting two dates gives days. |
| Colour | `Color.Red`, `RGBA(79, 70, 229, 1)` | A colour is CSS colour text such as `rgba(239, 68, 68, 1)`. |
| Record | `{ Name: "Asha" }` | |
| Table | `[1, 2, 3]`, a collection, a data table | |
| Blank | `Blank()` | No value. See below. |

### Comments

`// this is a comment to the end of the line` and `/* this one can span lines */` can be used anywhere between tokens. A block comment without its closing `*/` is an error.

### Text with values inside (string interpolation)

Put `$` before the opening quote and write formulas inside braces: `$"Hello {User().FullName}, you have {CountRows(Orders)} orders"`.
To write a brace, double it: `{{` and `}}`. To write a quote, double it as usual. The braces must not be empty.

## Operators

Listed from the tightest binding to the loosest. Operators on the same row are calculated left to right.

| Precedence | Operator | Meaning |
| --- | --- | --- |
| 1 (tightest) | `.` | Field of a record or column of a table |
| 1 | `%` after a value | Divide by 100 |
| 2 | `-` `+` `!` `Not` before a value | Negative, plain, not |
| 3 | `^` | Power (so `-2^2` is 4, and `2^3^2` is 64) |
| 4 | `*` `/` | Multiply, divide |
| 5 | `+` `-` | Add, subtract (with dates: add or subtract days) |
| 6 | `&` | Join text |
| 7 | `=` `<>` `<` `>` `<=` `>=` `in` `exactin` | Compare. `=` is equality, never assignment. `in` is true when a value is in a table or text is inside other text, ignoring case; `exactin` respects case |
| 8 | `&&` `And` | Both are true. The right side is not calculated when the left is false |
| 9 | `\|\|` `Or` | Either is true. The right side is not calculated when the left is true |
| 10 (loosest) | `;` | Chain several actions (behaviour properties only) |

Because `!` and `Not` bind tighter than comparisons, `!a = b` means `(!a) = b`. Write `Not(a = b)` or `!(a = b)` for the other reading.

## Blank and errors

**Blank.** Blank means "no value". It is what an empty input, a missing field or `Blank()` gives. In a calculation a blank is 0 for numbers, empty text for text and false for true/false, so `Blank() + 1` is 1 and `Blank() & "x"` is `"x"`. `Blank() = 0`, `Blank() = ""` and `Blank() = false` are all true. `IsBlank` is true for blank and for empty text. In comparisons and sorting a blank counts as 0 or as empty text. Reading a field of a blank value gives blank.

**Converting.** Values are converted when they are used, not when the formula is written. Text that looks like a number can be used as one (`"5" + 1` is 6, and `"5" = 5` is true); the number reader also accepts `1,234.5`, `12%` and `$3`. Text that is not a number is an error: `"abc" + 1` gives "Can't turn the text "abc" into a number".

**Errors.** When a calculation cannot be done (dividing by zero, a number that is not valid, text that is not a number, a bad pattern, a call to `Error("...")`) the formula stops and its result is an error with a message and the position in the formula. Errors are not values that travel through a table: the first one stops the formula.
- `IfError(value, fallback)` gives the fallback when the value is an error. `IsError` and `IsBlankOrError` test for one.
- Inside a fallback, `FirstError.Message` is the message.
- Some mistakes can never be caught by `IfError`: an unknown name or function, the wrong number of arguments, and a behaviour function in a data property. They are always reported.
- When a property's formula fails, the control behaves as if the property had its default value,.

## Data properties and behaviour properties

A property is either a **data property** or a **behaviour property**.
- Data properties (`Text`, `Fill`, `Items`, `Visible`, ...) calculate a value. They must not change anything, so behaviour functions (`Set`, `Patch`, `Navigate`, ...) and `;` chaining are errors there: "Behaviour function in a non-behaviour property".
- Behaviour properties (the *events*: `OnSelect`, `OnChange`, `OnVisible`, ...) run when something happens. They may call behaviour functions and may chain several steps with `;`:

```
=Set(Total, 0); Collect(Cart, { Item: Name }); Navigate(CartScreen)
```

The controls reference marks events with the kind `action`. The chain gives the value of its last step. A trailing `;` is allowed.

## Row scope: `ThisRecord`, `As` and `ThisItem`

Functions that take a formula to run for each row (`Filter`, `Sort`, `ForAll`, `LookUp`, `AddColumns`, `Sum(table, formula)`, `Concat`, ...) make the fields of the current row available **by name**:

```
=Filter(Contacts, Age > 30 && City = "Pune")
```

- **Shadowing.** A field name wins over a variable or control with the same name. Names of outer rows stay reachable when nothing in the inner row has that name.
- **`ThisRecord`** is the whole current row (the innermost one): `ForAll(Contacts, ThisRecord.Name)`.
- **`As`** names the row so that nested formulas can tell rows apart: `ForAll(Orders As o, CountRows(Filter(Lines As l, l.OrderId = o.Id)))`. `As` goes after a table argument inside a function call, not on its own.
- **`ThisItem`** is the item of a Gallery row. The Gallery supplies it; it is not a function row scope.
- `With(record, formula)` makes the fields of one record available by name.

## Named formulas and user-defined functions

The app-level `Formulas` text can hold several definitions, each ending with `;`:

```
TaxRate = 0.18;
Gross(net: Number): Number = net * (1 + TaxRate);
```

- `Name = expression;` defines a named formula: a value that is calculated when first needed and can be used like a variable that nobody can set.
- `Name(param: Type, ...): ReturnType = expression;` defines a function. The body is **one expression**. It can use its parameters, the app's names, enums and any function (including other user-defined ones) but not the row fields of the place it is called from. Recursion stops at depth 64.
- A name can be defined only once. A function cannot reuse the name of a built-in function, and no definition can reuse the name of an enum.
- A mistake in one definition is reported without hiding the others.

## Functions

151 built-in functions. A signature in square brackets means the argument is optional; "..." means more of the same may follow. A function marked as behaviour works only in behaviour properties.

- [Logic and errors](#logic-and-errors) (16)
- [Text](#text) (23)
- [Math](#math) (28)
- [Date and time](#date-and-time) (20)
- [Table](#table) (25)
- [Colour](#colour) (3)
- [Behaviour](#behaviour) (27)
- [JSON and regular expressions](#json-and-regular-expressions) (5)
- [Context and environment](#context-and-environment) (4)

### Logic and errors

Choosing between values, testing for blank, catching errors and converting to true/false.

| Function | What it does |
| --- | --- |
| `And(a, b, ...)` | True when every argument is true. |
| `Blank()` | An empty value. |
| `Boolean(value)` | Turns text such as "true" or a number into true/false. Blank stays blank. |
| `Coalesce(a, b, ...)` | Returns the first argument that is not blank. |
| `Error(text)` | Raises an error with a message. Use it with IfError or IsError. |
| `If(condition, then [, condition2, then2, ...] [, else])` | Returns the result for the first condition that is true. Blank when nothing matches and no else is given. |
| `IfError(value, fallback [, value2, fallback2, ...] [, default])` | Returns the value, or the fallback when the value is an error. With more pairs, the first value that fails gives its fallback; the optional last argument is used when nothing failed. FirstError.Message is available in fallbacks. |
| `IsBlank(value)` | True when the value is blank or empty text. |
| `IsBlankOrError(value)` | True when the value is blank, empty text or an error. |
| `IsEmpty(table)` | True when a table has no rows. |
| `IsError(value)` | True when calculating the value gives an error. |
| `IsNumeric(value)` | True for a number, or for text that can be read as a number. |
| `Not(value)` | Flips true and false. |
| `Or(a, b, ...)` | True when at least one argument is true. |
| `Switch(value, match1, result1 [, match2, result2, ...] [, default])` | Compares a value with each match in turn and returns the matching result. |
| `With(record, formula)` | Evaluates a formula with the fields of a record available by name. |

### Text

Building, searching and changing text. Positions start at 1.

| Function | What it does |
| --- | --- |
| `Char(code)` | The character for a code from 1 to 255. |
| `Concat(table, formula [, separator])` | Evaluates a formula for each row and joins the results. |
| `Concatenate(text1, text2, ...)` | Joins texts together. |
| `EncodeUrl(text)` | Makes text safe to put in a web address. |
| `EndsWith(text, end)` | True when the text ends with the other text (ignores case). |
| `Find(search, text [, start])` | Position of the search text inside the text (first is 1). Blank when not found. |
| `Left(text, count)` | The first characters of the text. |
| `Len(text)` | Number of characters in the text. |
| `Lower(text)` | Converts to lower case. |
| `Mid(text, start [, count])` | Characters from the middle of the text. The first character is number 1. |
| `PlainText(html)` | Removes HTML tags and turns entities such as &amp; into characters. |
| `Proper(text)` | Capitalises the first letter of every word. |
| `Replace(text, start, count, new)` | Replaces part of the text by position. The first character is number 1. |
| `Right(text, count)` | The last characters of the text. |
| `Split(text, separator)` | Splits text into a table with one row per piece. |
| `StartsWith(text, start)` | True when the text begins with the other text (ignores case). |
| `Substitute(text, old, new [, instance])` | Replaces text. With an instance number only that occurrence changes. |
| `Text(value [, format])` | Turns a number, date or value into text. Formats: "0.00", "#,##0", "dd/mm/yyyy", "yyyy-mm-dd", "hh:mm". |
| `Trim(text)` | Removes leading, trailing and repeated spaces. |
| `TrimEnds(text)` | Removes spaces from the start and end only. |
| `UniChar(code)` | The Unicode character for a code point. |
| `Upper(text)` | Converts to upper case. |
| `Value(text)` | Turns text such as "12.5" into a number. |

### Math

Numbers, rounding, statistics and trigonometry. Statistics functions accept either a list of values or a table and a formula.

| Function | What it does |
| --- | --- |
| `Abs(number)` | Removes the minus sign. |
| `Average(a, b, ...) or Average(table, formula)` | Mean of the values. Blank when there are none. |
| `Cos(radians)` | Cosine of an angle in radians. |
| `Count(table [, formula]) or Count(a, b, ...)` | Number of numeric values (blank and text are skipped). |
| `CountA(table [, formula]) or CountA(a, b, ...)` | Number of values that are not blank. |
| `Degrees(radians)` | Converts radians to degrees. |
| `Exp(number)` | e raised to a power. |
| `Int(number)` | Rounds down to the nearest whole number. |
| `Ln(number)` | Natural logarithm. |
| `Log(number [, base])` | Logarithm of a number. Base defaults to 10. |
| `Max(a, b, ...) or Max(table, formula)` | Largest value. |
| `Min(a, b, ...) or Min(table, formula)` | Smallest value. |
| `Mod(number, divisor)` | Remainder after dividing. Takes the sign of the divisor. |
| `Pi()` | The number pi. |
| `Power(base, exponent)` | Raises a number to a power. |
| `Radians(degrees)` | Converts degrees to radians. |
| `Rand()` | A random number from 0 up to (not including) 1. |
| `RandBetween(low, high)` | A random whole number between low and high, inclusive. |
| `Round(number [, digits])` | Rounds to the nearest value (halves round away from zero). |
| `RoundDown(number [, digits])` | Rounds toward zero. |
| `RoundUp(number [, digits])` | Rounds away from zero. |
| `Sin(radians)` | Sine of an angle in radians. |
| `Sqrt(number)` | Square root. |
| `StdevP(table [, formula]) or StdevP(a, b, ...)` | Population standard deviation. Blank when there are no values. |
| `Sum(a, b, ...) or Sum(table, formula)` | Adds values together. |
| `Tan(radians)` | Tangent of an angle in radians. |
| `Trunc(number [, digits])` | Removes the decimals (or keeps the given number of digits) without rounding. |
| `VarP(table [, formula]) or VarP(a, b, ...)` | Population variance. Blank when there are no values. |

### Date and time

Dates are date-and-time values. A date without a time is midnight.

| Function | What it does |
| --- | --- |
| `Date(year, month, day)` | Builds a date. Months and days may overflow into the next month or year. |
| `DateAdd(date, amount, unit)` | Adds to a date. Unit is "Days", "Months", "Years", "Hours" or "Minutes". |
| `DateDiff(start, end [, unit])` | Whole units from start to end. Unit defaults to Days. |
| `DateTimeValue(text [, language])` | Turns text such as "2024-03-05 14:30" into a date and time. |
| `DateValue(text [, language])` | Turns text such as "2024-03-05" into a date (time removed). |
| `Day(date)` | The day of the month. |
| `EDate(date, months)` | The same day some months earlier or later (clamped to the end of a short month). |
| `EOMonth(date, months)` | The last day of the month, some months earlier or later. |
| `Hour(date)` | The hour, 0 to 23. |
| `IsToday(date)` | True when the date is today. |
| `Minute(date)` | The minute, 0 to 59. |
| `Month(date)` | The month of a date, 1 to 12. |
| `Now()` | The current date and time. |
| `Second(date)` | The second, 0 to 59. |
| `Time(hour, minute, second)` | Today at the given time. Values may overflow into the next day. |
| `TimeValue(text [, language])` | Turns text such as "2:30 PM" or "14:30:15" into a time (on today's date). |
| `Today()` | Today at midnight. |
| `WeekNum(date [, startOfWeek])` | Week of the year. Week 1 holds 1 January. Start of week: 1 Sunday (default), 2 Monday, 11-17 Monday..Sunday, 21 ISO 8601 weeks. |
| `Weekday(date [, type])` | Day of the week. Type 1 (default): Sunday = 1. Type 2: Monday = 1. Type 3: Monday = 0. |
| `Year(date)` | The year of a date. |

### Table

Functions that read, filter, sort, reshape and group tables. Most of them evaluate a formula once per row (see "Row scope" above).

| Function | What it does |
| --- | --- |
| `AddColumns(table, "name", formula [, "name2", formula2, ...])` | Adds calculated columns to every row. |
| `Choices(table, "column") or Choices(Table.Column)` | A one-column table (Value) of the different values in a column, without blanks. |
| `CountIf(table, condition)` | Number of rows where the condition is true. |
| `CountRows(table)` | Number of rows in a table. |
| `Defaults(collection)` | An empty record, used with Patch to create a new row. |
| `Distinct(table, formula)` | A one-column table (Value) of the different results of a formula. |
| `DropColumns(table, "column" [, "column2", ...])` | Removes columns from every row. |
| `Filter(table, condition [, condition2, ...])` | Rows of the table where every condition is true. |
| `First(table)` | The first row, or blank for an empty table. |
| `FirstN(table [, count])` | The first rows of a table (default 1). |
| `ForAll(table, formula)` | Evaluates a formula for every row and returns the results as a table. |
| `GroupBy(table, "column" [, "column2", ...], "GroupName")` | Groups rows that share the same values in the listed columns. Each result row has those columns plus GroupName: a table of the rows in the group. |
| `Index(table, position)` | The row at a position. The first row is 1. |
| `Last(table)` | The last row, or blank for an empty table. |
| `LastN(table [, count])` | The last rows of a table (default 1). |
| `LookUp(table, condition [, result])` | The first row where the condition is true (or the result formula for that row). Blank when nothing matches. |
| `RenameColumns(table, "old", "new" [, "old2", "new2", ...])` | Renames columns. |
| `Search(table, text, "column1" [, "column2", ...])` | Rows where any listed column contains the text (ignores case). Blank text keeps every row. |
| `Sequence(count [, start [, step]])` | A table of numbers (Value): 1, 2, 3... |
| `ShowColumns(table, "column" [, "column2", ...])` | Keeps only the listed columns. |
| `Shuffle(table)` | The rows in random order. |
| `Sort(table, formula [, SortOrder])` | Sorts rows by the value of a formula. |
| `SortByColumns(table, "column" [, SortOrder, "column2", ...])` | Sorts rows by one or more columns. |
| `Table(record1 [, record2, ...])` | Builds a table from records. |
| `Ungroup(table, "GroupName")` | Flattens the groups made by GroupBy back into one table of rows. |

### Colour

Building and adjusting colours. See also the Color enum below.

| Function | What it does |
| --- | --- |
| `ColorFade(color, amount)` | Lightens (positive, up to 1) or darkens (negative, down to -1) a colour. |
| `ColorValue(text)` | Turns a colour name or "#rrggbb" text into a colour. |
| `RGBA(red, green, blue, alpha)` | Builds a colour. Red, green and blue go from 0 to 255, alpha from 0 to 1. |

### Behaviour

Functions with side effects. They work only in behaviour properties such as OnSelect and OnChange; anywhere else they are an error.

| Function | What it does |
| --- | --- |
| `Back()` | Returns to the previous screen. |
| `Clear(collection)` | Removes every row from a collection. |
| `ClearCollect(collection, table)` | Replaces the contents of a collection. |
| `Collect(collection, item [, item2, ...])` | Adds records (or the rows of a table) to a collection. |
| `Concurrent(action1, action2, ...)` | Runs several actions. Every action runs even when one fails; the first failure is then reported. |
| `Copy(text)` | Copies text to the clipboard. |
| `Download(url)` | Starts a download from a web address. |
| `EditForm(Form)` | Switches a form to Edit mode. |
| `Exit()` | Closes the running app. |
| `Launch(url)` | Opens a web address. |
| `Navigate(Screen)` | Goes to another screen. |
| `NewForm(Form)` | Switches a form to New mode with empty fields. |
| `Notify(message [, NotificationType])` | Shows a message to the user. |
| `Patch(collection, base, changes) or Patch(record, changes)` | Changes a record, or creates a new one when base is Defaults(collection). Returns the stored record. With a record as the first argument it only merges the records and returns the result. |
| `Refresh(table)` | Reloads a table from storage. |
| `Remove(collection, record [, record2, ...])` | Removes records from a collection. |
| `RemoveIf(collection, condition)` | Removes every row where the condition is true. |
| `Reset(control)` | Puts an input control back to its default value. |
| `ResetForm(Form)` | Puts every field of a form back to its starting value. |
| `Select(control)` | Runs the OnSelect of a control. |
| `Set(variable, value)` | Sets a global variable. |
| `SetFocus(control)` | Moves the keyboard focus to a control. |
| `SubmitForm(Form)` | Saves the data entered in a form. |
| `Trace(message [, data])` | Writes a line to the debug console. |
| `UpdateContext({ name: value, ... })` | Sets context variables for the current screen. |
| `UpdateIf(collection, condition, changes)` | Changes every row where the condition is true. |
| `ViewForm(Form)` | Switches a form to View mode. |

### JSON and regular expressions

Reading and writing JSON text, and matching text against patterns. Patterns are regular expressions; the Match and MatchOptions enums help build them.

| Function | What it does |
| --- | --- |
| `IsMatch(text, pattern [, options])` | True when the whole text matches the pattern (a regular expression). Options: MatchOptions.Contains, BeginsWith, EndsWith, IgnoreCase, Multiline. |
| `JSON(value [, indent])` | Turns a value, record or table into JSON text. Indent is a number of spaces. |
| `Match(text, pattern [, options])` | The first match as a record with FullMatch, StartMatch, SubMatches and named groups. Blank when nothing matches. |
| `MatchAll(text, pattern [, options])` | Every match as a table of records (FullMatch, StartMatch, SubMatches, named groups). |
| `ParseJSON(text)` | Reads JSON text into a record, a table or a single value. |

### Context and environment

Facts about the signed-in user, the address the app was opened with, and generated identifiers.

| Function | What it does |
| --- | --- |
| `GUID([text])` | A new random unique id, or the GUID that the text spells. |
| `Language()` | The language of the user, such as "en-US". |
| `Param(name)` | A value passed to the app in the address, such as the id in #run-app?id=5. Blank when missing. |
| `User()` | The signed-in user: a record with FullName, Email and Image. |

## Enums

24 built-in lists of named values, written `EnumName.Member`, for example `Align.Center` or `Color.Red`.

### Align

Used by: `Heading.Align`, `Label.Align`, `LinkButton.Align`, `RichText.Align`.

3 members: `Left`, `Center`, `Right`.

### AlignItems

Used by: 83 properties on 75 controls (for example `Accordion.AlignSelf`, `Alert.AlignSelf`, `AnimatedIcon.AlignSelf`).

5 members: `Auto`, `Start`, `Center`, `End`, `Stretch`.

### Anchor

Used by: 148 properties on 74 controls (for example `Accordion.AnchorH`, `Accordion.AnchorV`, `Alert.AnchorH`).

5 members: `Start`, `End`, `Stretch`, `Center`, `Scale`.

### AnimatedIcon

Names of the animated icons. The value is the text `anim:<id>`, which is accepted wherever an icon name is.

Used by: `AnimatedIcon.Icon`.

300 members. The first 30: `Activity`, `Airplay`, `AlertCircle`, `AlertOctagon`, `AlertTriangle`, `AlignCenter`, `AlignJustify`, `AlignLeft`, `AlignRight`, `Anchor`, `Aperture`, `Archive`, `ArrowDown`, `ArrowDownCircle`, `ArrowDownLeft`, `ArrowDownRight`, `ArrowLeft`, `ArrowLeftCircle`, `ArrowRight`, `ArrowRightCircle`, `ArrowUp`, `ArrowUpCircle`, `ArrowUpLeft`, `ArrowUpRight`, `AtSign`, `Award`, `BarChart`, `BarChart2`, `Battery`, `BatteryCharging`, ...

The full list is in the icon picker: select an icon property in the Studio and open the picker. Formulas can use any member.

### ButtonStyle

Used by: `Button.Style`.

5 members: `Primary`, `Secondary`, `Outline`, `Ghost`, `Destructive`.

### ChartType

Used by: `Chart.Type`.

5 members: `Bar`, `Line`, `Area`, `Pie`, `Donut`.

### Color

Named colours. Each member is a colour value: `=Color.Red`. `Color.Transparent` has zero alpha.

Used by: 8 properties on 8 controls (for example `Column.Fill`, `Container.Fill`, `Gallery.Fill`).

51 members: `Red`, `Green`, `Blue`, `Black`, `White`, `Gray`, `LightGray`, `DarkGray`, `Orange`, `Yellow`, `Purple`, `Pink`, `Teal`, `Cyan`, `Brown`, `Transparent`, `Crimson`, `Maroon`, `Navy`, `Indigo`, `Violet`, `Magenta`, `Fuchsia`, `Rose`, `Coral`, `Salmon`, `Amber`, `Gold`, `Lime`, `Olive`, `Emerald`, `ForestGreen`, `SeaGreen`, `Mint`, `Aqua`, `Turquoise`, `Sky`, `SkyBlue`, `RoyalBlue`, `Azure`, `Lavender`, `Plum`, `Tan`, `Beige`, `Ivory`, `Khaki`, `Silver`, `Slate`, `Zinc`, `Charcoal`, `Snow`.

### DisplayMode

Whether a control accepts input (Edit), only shows its value (View) or is greyed out (Disabled).

Used by: 27 properties on 27 controls (for example `Button.DisplayMode`, `Checkbox.DisplayMode`, `ColorPicker.DisplayMode`).

3 members: `Edit`, `View`, `Disabled`.

### Fit

Used by: no built-in property lists it as a default or a choice. It is available in formulas.

3 members: `Cover`, `Contain`, `Fill`.

### FontWeight

Used by: `Heading.FontWeight`, `Label.FontWeight`.

3 members: `Normal`, `Semibold`, `Bold`.

### FormMode

Mode of a Form. NewForm, EditForm and ViewForm switch it.

Used by: `Form.Mode`.

3 members: `Edit`, `New`, `View`.

### Icon

Names of the built-in icons. The value is the icon name as text, so `Icon.Plus` and `"Plus"` are the same.

Used by: no built-in property lists it as a default or a choice. It is available in formulas.

91 members. The first 30: `Plus`, `Minus`, `Trash`, `Edit`, `Pencil`, `Search`, `Check`, `X`, `ChevronRight`, `ChevronLeft`, `ChevronUp`, `ChevronDown`, `ArrowRight`, `ArrowLeft`, `ArrowUp`, `ArrowDown`, `Home`, `Settings`, `User`, `Users`, `Mail`, `Phone`, `Calendar`, `Clock`, `Bell`, `Star`, `Heart`, `Bookmark`, `Folder`, `File`, ...

The full list is in the icon picker: select an icon property in the Studio and open the picker. Formulas can use any member.

### Justify

Used by: 9 properties on 9 controls (for example `Card.Justify`, `Column.Justify`, `Container.Justify`).

5 members: `Start`, `Center`, `End`, `SpaceBetween`, `SpaceAround`.

### Layout

Used by: 9 properties on 9 controls (for example `Card.LayoutMode`, `Column.LayoutMode`, `Container.LayoutMode`).

4 members: `Manual`, `Row`, `Column`, `Grid`.

### Match

Pattern pieces for IsMatch, Match and MatchAll. Join them with `&`: `Match.Letter & Match.Hyphen & Match.Letter`.

Used by: no built-in property lists it as a default or a choice. It is available in formulas.

19 members: `Any`, `Comma`, `Digit`, `Email`, `Hyphen`, `LeftParen`, `Letter`, `MultipleDigits`, `MultipleLetters`, `MultipleNonSpaces`, `MultipleSpaces`, `NonSpace`, `OptionalDigits`, `OptionalLetters`, `OptionalNonSpaces`, `OptionalSpaces`, `Period`, `RightParen`, `Space`.

### MatchOptions

Options for IsMatch, Match and MatchAll. Join them with `&`: `MatchOptions.Contains & MatchOptions.IgnoreCase`.

Used by: no built-in property lists it as a default or a choice. It is available in formulas.

6 members: `Complete`, `Contains`, `BeginsWith`, `EndsWith`, `IgnoreCase`, `Multiline`.

### NotificationType

Second argument of Notify.

Used by: no built-in property lists it as a default or a choice. It is available in formulas.

4 members: `Information`, `Success`, `Warning`, `Error`.

### Orientation

Used by: `Divider.Orientation`, `RadioGroup.Orientation`, `Steps.Orientation`.

2 members: `Horizontal`, `Vertical`.

### SelectionMode

Used by: `ComboBox.SelectionMode`, `DataTable.SelectionMode`, `ToggleGroup.SelectionMode`.

3 members: `None`, `Single`, `Multiple`.

### Side

Used by: `Sheet.Side`.

4 members: `Left`, `Right`, `Top`, `Bottom`.

### Size

Used by: `IconButton.Size`, `ToggleGroup.Size`.

3 members: `Small`, `Medium`, `Large`.

### SortOrder

Direction argument of Sort and SortByColumns.

Used by: no built-in property lists it as a default or a choice. It is available in formulas.

2 members: `Ascending`, `Descending`.

### TextMode

Used by: no built-in property lists it as a default or a choice. It is available in formulas.

4 members: `SingleLine`, `MultiLine`, `Password`, `Number`.

### Variant

Used by: `Badge.Variant`, `IconButton.Variant`, `MenuButton.Variant`, `SplitButton.Variant`, `TagList.Variant`, `ToggleGroup.Variant`.

5 members: `Default`, `Secondary`, `Outline`, `Ghost`, `Destructive`.

## Differences from Power Fx

Fx was written from the documented behaviour of Power Fx and is **not compatible** with it: apps cannot be imported from or exported to Power Apps. Things that differ, or that people tend to trip over:

- **No static type checking.** Types are not inferred while you type. Values are converted when a formula runs and a wrong type shows up then, as an error message on that property.
- **Errors stop the formula.** A failing calculation is an error for the whole formula, not a value inside a table. Use `IfError` to recover.
- **Division by zero is an error** ("Can't divide by zero"), in `/` and in `Mod`. So is any result that is not a finite number.
- **`IfError` has two forms.** `IfError(value, fallback)` and the multi-pair form `IfError(value1, fallback1, value2, fallback2, ..., default)`: the first value that fails gives its fallback; the optional last argument is returned when nothing failed. Inside a fallback only `FirstError.Message` and `FirstError.Kind` (always `"Custom"`) exist; there is no `AllErrors`.
- **User-defined functions have a single expression as their body** (no `;` chaining). See "Named formulas" above.
- **Enum names shadow your own names.** A variable, collection or control called `Size`, `Side`, `Fit`, `Layout`, `Icon`, `Variant`, `Match`, `Anchor`, `Justify`, `Orientation`, `Color`, `Align` or any other enum name (see the list of enums below) cannot be reached from a formula: the enum wins. Pick other names. A named formula with an enum's name is rejected.
- **`;` chaining works only in behaviour properties.**
- **Text is compared without regard to case** by `=`, `<>`, `<`, `>` and `in`. Use `exactin` for a case-sensitive test.
- **One locale.** Syntax and numbers are always en-US: a point for decimals, a comma between arguments, `Language()` is always `"en-US"`. The optional language argument of `DateValue`, `DateTimeValue` and `TimeValue` is accepted but has no effect. Number text may contain commas as thousands separators, so `Value("1,5")` is 15.
- **String interpolation uses `$"...{formula}..."`**; write `{{` and `}}` for literal braces. See "The basics".
- **`Patch` with a record as its first argument** (`Patch(record, changes)`) only merges two records and does not touch a data source.
- **Regular expressions use JavaScript syntax.**

Behaviour that matches Power Fx but surprises people:
- `IsMatch` must match the **whole text** unless you add `MatchOptions.Contains`, `BeginsWith` or `EndsWith`. `Match` and `MatchAll` find a match **anywhere** in the text by default.

### Not supported yet
- Static type inference and type annotations on ordinary formulas.
- Pushing filters down to the database (delegation): an app loads up to 5,000 rows of each table, warns when the table is longer, and formulas filter those rows in memory.
- Waiting for the server inside an action formula: `Patch`, `Collect` and `Remove` update the screen at once and the server decides afterwards. If the server refuses, the change is rolled back and an error event is raised, but a step that came after it in the same chain (for example `Navigate`) has already run. Forms wait for the server before reporting success.
- Other locales and other list separators.
