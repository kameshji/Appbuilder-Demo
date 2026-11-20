/**
 * Touch matrix of the UI component registry (P2-A, docs/dev/phone.md "Touch matrix"). One entry per UI component:
 *  - interactive: it reacts to taps (then RenderNode gives it the 44 x 44 px touch area when it is smaller; hit.ts
 *    forwards a tap on that area to its nearest inner control);
 *  - status: 'works' (usable by touch as it was), 'fixed' (changed for touch, P2-A or the touch-limitation package), 'limitation' (known gap, in the note);
 *  - note: what was checked or what is missing.
 * src/phone/touch.test.ts checks that every UI component of the registry has an entry; the exit script
 * scripts/exit-check/p2-phone.mjs measures the real touch areas in Chrome's phone emulation.
 * Charts (Chart, Sparkline, Visual) belong to package C; their entries record what we observed. Nothing here was tested on a real phone: 'fixed' means verified in Chrome's phone emulation (scripts/exit-check/p2-phone.mjs, section E) and by the pure logic tests in phone.test.ts.
 */
export type TouchStatus = 'works' | 'fixed' | 'limitation'
export interface TouchEntry { interactive: boolean; status: TouchStatus; note: string }

const W = (note: string, interactive = true): TouchEntry => ({ interactive, status: 'works', note })
const F = (note: string, interactive = true): TouchEntry => ({ interactive, status: 'fixed', note })
/** a known gap (no entry uses it right now; keep it for the next one) */
export const L = (note: string, interactive = true): TouchEntry => ({ interactive, status: 'limitation', note })
const D = (note = 'Display only: nothing to tap.'): TouchEntry => ({ interactive: false, status: 'works', note })

export const TOUCH_MATRIX: Record<string, TouchEntry> = {
  Screen: D('The screen scrolls vertically on phones (fluid layout rule).'),
  Label: D(),
  Button: F('44 px touch area when smaller; no double-tap zoom.'),
  TextInput: F('Touch area; 16 px text on iOS (no zoom on focus); kept above the keyboard.'),
  Checkbox: F('Default height 24 px: the touch area makes it 44 px.'),
  Toggle: F('Default height 28 px: the touch area makes it 44 px.'),
  Dropdown: F('Opens a bottom sheet with search and 44 px rows, lifted above the keyboard (--kb). Desktop keeps the Radix list.'),
  Image: D(),
  Rectangle: D(),
  Container: D('A container; its children are checked on their own.'),
  Gallery: W('Rows scroll by touch; infinite scroll unchanged. Swipe actions on rows are not built (P2-A limit).', true),
  TextArea: F('Kept above the keyboard; 16 px text on iOS.'),
  NumberInput: F('inputmode decimal, or numeric only for a bounded whole-number range from 0 up; a +/- button where negatives are allowed (iOS pads have no minus); a decimal comma is read as a point.'),
  PasswordInput: F('Touch area; 16 px text on iOS.'),
  SearchBox: F('Touch area; 16 px text on iOS.'),
  RadioGroup: W('Rows of 104 px default height: each option is tappable.'),
  ComboBox: F('Bottom sheet with search and 44 px rows; multiple selection has a Done button; server-backed lists load more near the end.'),
  PersonPicker: F('Bottom sheet with search and larger rows; desktop keeps the popover.'),
  TagInput: F('Touch area (36 px default height).'),
  DatePicker: F('Native date input on touch (same SelectedDate value). The field shows the device format: Format is ignored there. A clear button stays.'),
  DateRangePicker: F('Two native date inputs on touch; an end before the start moves the start. Format is ignored there.'),
  TimePicker: F('Native time input on touch (same HH:MM value, minute step kept). Use24Hour and Format are ignored there: the device decides.'),
  Slider: F('Thumb gets a 44 px touch area.'),
  RangeSlider: F('Thumbs get a 44 px touch area.'),
  Rating: F('Stars are small: taps around a star reach the nearest star.'),
  ToggleGroup: F('Touch area; a tap reaches the nearest item.'),
  SegmentedControl: F('Touch area; a tap reaches the nearest segment.'),
  IconButton: F('40 px default: the touch area makes it 44 px.'),
  LinkButton: F('Touch area (32 px default height).'),
  SplitButton: F('Touch area; the arrow and the main part stay separate targets.'),
  MenuButton: W('Menu items are 32 px high in the popover (desktop menu).'),
  FileUpload: W('Opens the system file picker (camera and gallery on phones).'),
  ColorPicker: W('Opens the popover; swatches are small (desktop sizing).'),
  Stepper: F('Touch area; a tap reaches the nearest of - and +.'),
  PinInput: W('48 px boxes.'),
  Form: F('Image columns: Take photo (native camera), Use camera (in-page), photos resized to 1600 px and turned upright. Sticky save bar on phones: the Save/Cancel bar stays reachable above the keyboard. Choice and lookup fields still use the Radix select.'),
  Timer: W('Not tapped by users.', false),
  BarcodeScanner: F('New: 48 px button, full-screen scanner with 48 px buttons.'),
  ScanInput: F('New: 48 px field and camera button; keyboard-wedge scanners.'),
  SignaturePad: F('New: pointer events (finger, stylus, mouse), touch-action none on the pad so the page does not scroll and pull to refresh does not start while signing; 44 px Clear button. Too big for the touch audit (its own pad is the target). Drawing by touch checked in Chrome emulation only.'),
  Row: D('Layout.'),
  Column: D('Layout.'),
  Grid: D('Layout.'),
  Card: D('Layout.'),
  ScrollArea: W('Scrolls by touch (native scrolling).', false),
  Divider: D(),
  Spacer: D(),
  Dialog: F('Bottom sheet at phone width on touch devices (drag handle, 44 px close button); centred on desktop.'),
  Sheet: F('Left and right sheets become bottom sheets at phone width on touch devices; a top sheet stays a top sheet.'),
  Accordion: W('Header rows are tappable.'),
  Heading: D(),
  RichText: D(),
  Badge: D(),
  Avatar: D(),
  AvatarGroup: D(),
  Icon: F('Touch area when OnSelect is used (40 px default).'),
  Shape: D(),
  TagList: W('Tags are small (24 px) when OnSelect is used: touch area applies to the whole list only.'),
  StatCard: D(),
  Timeline: D(),
  DataTable: F('Card layout below 600 px on touch devices; CardColumns sets the column priority (default: first text column as title, up to 5 more). A Sort by select replaces the headers. Desktop table unchanged.'),
  List: W('Rows are tappable at default sizes.'),
  Calendar: W('Day cells are tappable; small on phones.'),
  RecordTimeline: D('Read-only list.'),
  ActivityList: D('Read-only list.'),
  ApprovalsPanel: W('Approve and reject buttons are tappable (the Approvals page is phone-ready).'),
  Tabs: F('Tab list scrolls sideways instead of squeezing; touch area.'),
  Breadcrumb: F('Touch area; a tap reaches the nearest item.'),
  Pagination: F('Touch area; a tap reaches the nearest page button.'),
  NavMenu: W('Items are tappable.'),
  TopBar: W('Items are tappable.'),
  Steps: W('Steps are tappable.'),
  Progress: D(),
  CircularProgress: D(),
  Spinner: D(),
  Skeleton: D(),
  Alert: F('The dismiss button has a 44 px touch area.'),
  EmptyState: W('Action button is tappable.'),
  Video: W('The browser\'s own video player buttons.'),
  Audio: W('The browser\'s own audio player buttons.'),
  AnimatedIcon: F('Touch area when tapped (OnSelect).'),
  Chart: W('Package C: reviewed. The tooltip shows on a tap (checked in Chrome emulation); no change needed.'),
  Sparkline: D('Package C: display only.'),
  Visual: F('Package C: points get a 44 px hit circle, a tap shows the tooltip and a tap elsewhere hides it, legend rows are 44 px.'),
  PrintButton: F('44 px touch area; busy state (disabled, spinner) while the PDF is made so a second tap cannot download twice. The download itself on iOS Safari is not verified.'),
}

export function touchEntry(type: string): TouchEntry | undefined {
  return TOUCH_MATRIX[type]
}
/** RenderNode: give this UI component a 44 px touch area when it is smaller */
export function wantsHitArea(type: string): boolean {
  return TOUCH_MATRIX[type]?.interactive === true
}
