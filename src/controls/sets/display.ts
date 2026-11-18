import type { ControlType } from '@/contracts'
import { Row, Column, Grid, Card, ScrollArea, Divider, Spacer } from '../display/layout'
import { Dialog, Sheet, Accordion, Tabs } from '../display/tabs-overlays'
import {
  Heading, RichText, BadgeControl, Avatar, AvatarGroup, IconControl, Shape, TagList, StatCard, Timeline,
} from '../display/basics'
import { DataTable, ListControl } from '../display/data'
import { ActivityList, RecordTimeline } from '../display/collab'
import { CalendarControl, Video, Audio } from '../display/media'
import { Breadcrumb, Pagination, NavMenu, TopBar, Steps } from '../display/nav'
import { ProgressControl, CircularProgress, Spinner, Skeleton, Alert, EmptyState } from '../display/feedback'
import { Chart, Sparkline } from '../display/charts'
import { AnimatedIconControl } from '../icon/AnimatedIconControl'

/** Insert-pane order: Layout -> Display -> Data -> Navigation -> Feedback -> Media -> Charts. */
export const displayControls: ControlType[] = [
  // Layout (Container and Gallery are registered by the architect before this list)
  Row, Column, Grid, Card, ScrollArea, Divider, Spacer, Dialog, Sheet, Accordion,
  // Display
  Heading, RichText, BadgeControl, Avatar, AvatarGroup, IconControl, Shape, TagList, StatCard, Timeline,
  // Data
  DataTable, ListControl, CalendarControl, RecordTimeline, ActivityList,
  // Navigation
  Tabs, Breadcrumb, Pagination, NavMenu, TopBar, Steps,
  // Feedback
  ProgressControl, CircularProgress, Spinner, Skeleton, Alert, EmptyState,
  // Media
  Video, Audio, AnimatedIconControl,
  // Charts
  Chart, Sparkline,
]
