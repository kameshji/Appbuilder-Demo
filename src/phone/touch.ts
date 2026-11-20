/**
 * Touch matrix of the UI component registry (P2-A, docs/dev/phone.md "Touch matrix"). One entry per UI component:
 *  - interactive: it reacts to taps (then RenderNode gives it the 44 x 44 px touch area when it is smaller; hit.ts
 *    forwards a tap on that area to its nearest inner control);
 *  - status: 'works' (usable by touch as it was), 'fixed' (changed in P2-A), 'limitation' (known gap, in the note);
 *  - note: what was checked or what is missing.
 * src/phone/touch.test.ts checks that every UI component of the registry has an entry; the exit script
 * scripts/exit-check/p2-phone.mjs measures the real touch areas in Chrome's phone emulation.
 * Charts (Chart, Sparkline, Visual) belong to package C; their entries record what we observed.
 */
export type TouchStatus = 'works' | 'fixed' | 'limitation'
export interface TouchEntry { interactive: boolean; status: TouchStatus; note: string }

const W = (note: string, interactive = true): TouchEntry => ({ interactive, status: 'works', note })
const F = (note: string, interactive = true): TouchEntry => ({ interactive, status: 'fixed', note })
const L = (note: string, interactive = true): TouchEntry => ({ interactive, status: 'limitation', note })
const D = (note = 'Display only: nothing to tap.'): TouchEntry => ({ interactive: false, status: 'works', note })

export const TOUCH_MATRIX: Record<string, TouchEntry> = {
  Screen: D('The screen scrolls vertically on phones (fluid layout rule).'),
  Label: D(),
  Button: F('44 px touch area when smaller; no double-tap zoom.'),
  TextInput: F('Touch area; 16 px text on iOS (no zoom on focus); kept above the keyboard.'),
  Checkbox: F('Default height 24 px: the touch area makes it 44 px.'),
  Toggle: F('Default height 28 px: the touch area makes it 44 px.'),
  Dropdown: L('Opens the desktop list (Radix select), which works by touch; not a bottom sheet with search yet.'),
  Image: D(),
  Rectangle: D(),
  Container: D('A container; its children are checked on their own.'),
  Gallery: W('Rows scroll by touch; infinite scroll unchanged. Swipe actions on rows are not built (P2-A limit).', true),
  TextArea: F('Kept above the keyboard; 16 px text on iOS.'),
  NumberInput: L('Numeric keyboard (inputmode) and the stepper buttons were not changed in P2-A.'),
  PasswordInput: F('Touch area; 16 px text on iOS.'),
  SearchBox: F('Touch area; 16 px text on iOS.'),
  RadioGroup: W('Rows of 104 px default height: each option is tappable.'),
  ComboBox: L('The search list is the desktop popover; usable by touch, not a bottom sheet yet.'),
  PersonPicker: L('Desktop popover; usable by touch, not a bottom sheet yet.'),
  TagInput: F('Touch area (36 px default height).'),
  DatePicker: L('Uses the calendar popover, not the native date picker.'),
  DateRangePicker: L('Uses the calendar popover, not the native picker.'),
  TimePicker: L('Uses its own lists, not the native time picker.'),
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
  Form: F('Image columns: Take photo (native camera), Use camera (in-page), photos resized to 1600 px and turned upright. No sticky save bar yet.'),
  Timer: W('Not tapped by users.', false),
  BarcodeScanner: F('New: 48 px button, full-screen scanner with 48 px buttons.'),
  ScanInput: F('New: 48 px field and camera button; keyboard-wedge scanners.'),
  Row: D('Layout.'),
  Column: D('Layout.'),
  Grid: D('Layout.'),
  Card: D('Layout.'),
  ScrollArea: W('Scrolls by touch (native scrolling).', false),
  Divider: D(),
  Spacer: D(),
  Dialog: L('Centred dialog, not a bottom sheet on phones; close button is 24 px.'),
  Sheet: L('Side sheet; on phones it is not turned into a bottom sheet.'),
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
  DataTable: L('Rows scroll and select by touch; no card layout on narrow screens yet (use a Gallery or List for phones).'),
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
  Alert: L('The dismiss button is small (desktop sizing).'),
  EmptyState: W('Action button is tappable.'),
  Video: W('The browser\'s own video player buttons.'),
  Audio: W('The browser\'s own audio player buttons.'),
  AnimatedIcon: F('Touch area when tapped (OnSelect).'),
  Chart: L('Package C: tooltips appear on hover/tap; not reviewed for touch in P2-A.'),
  Sparkline: D('Package C: display only.'),
  Visual: L('Package C: not reviewed for touch in P2-A.'),
  PrintButton: L('Package B: gets the 44 px touch area when smaller; the print flow itself was not reviewed on phones in P2-A.'),
}

export function touchEntry(type: string): TouchEntry | undefined {
  return TOUCH_MATRIX[type]
}
/** RenderNode: give this UI component a 44 px touch area when it is smaller */
export function wantsHitArea(type: string): boolean {
  return TOUCH_MATRIX[type]?.interactive === true
}
