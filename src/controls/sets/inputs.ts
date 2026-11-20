import type { ControlType } from '@/contracts'
import { TextArea } from '../inputs/TextArea'
import { NumberInput } from '../inputs/NumberInput'
import { PasswordInput } from '../inputs/PasswordInput'
import { SearchBox } from '../inputs/SearchBox'
import { RadioGroup } from '../inputs/RadioGroup'
import { ComboBox } from '../inputs/ComboBox'
import { DatePicker } from '../inputs/DatePicker'
import { DateRangePicker } from '../inputs/DateRangePicker'
import { TimePicker } from '../inputs/TimePicker'
import { Slider } from '../inputs/Slider'
import { RangeSlider } from '../inputs/RangeSlider'
import { Rating } from '../inputs/Rating'
import { ToggleGroup } from '../inputs/ToggleGroup'
import { SegmentedControl } from '../inputs/SegmentedControl'
import { IconButton } from '../inputs/IconButton'
import { LinkButton } from '../inputs/LinkButton'
import { SplitButton } from '../inputs/SplitButton'
import { MenuButton } from '../inputs/MenuButton'
import { FileUpload } from '../inputs/FileUpload'
import { ColorPicker } from '../inputs/ColorPicker'
import { Stepper } from '../inputs/Stepper'
import { PinInput } from '../inputs/PinInput'
import { Form } from '../inputs/Form'
import { Timer } from '../inputs/Timer'
import { PersonPicker, TagInput } from '../display/collab'
import { BarcodeScanner, ScanInput } from '../inputs/Scan'

/** Insert-pane order (SPEC2 section 3, Inputs agent). */
export const inputControls: ControlType[] = [
  TextArea,
  NumberInput,
  PasswordInput,
  SearchBox,
  RadioGroup,
  ComboBox,
  PersonPicker,
  TagInput,
  DatePicker,
  DateRangePicker,
  TimePicker,
  Slider,
  RangeSlider,
  Rating,
  ToggleGroup,
  SegmentedControl,
  IconButton,
  LinkButton,
  SplitButton,
  MenuButton,
  FileUpload,
  ColorPicker,
  Stepper,
  PinInput,
  Form,
  Timer,
  // P2-A phone: scanning
  BarcodeScanner,
  ScanInput,
]
