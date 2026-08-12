/**
 * THE ADMIN CONSOLE'S CHART PRIMITIVES.
 *
 *   import { BarRows, ColumnChart, HistogramChart, SplitBar, RunningTotalChart,
 *            ChartFigure, ChartNote, money, clubDayOf } from '@/components/charts';
 *   import { buildBars, buildColumns, buildHistogram, buildSplit,
 *            buildRunningTotal, computeRunningScale } from '@/lib/charts';
 *
 * FOUR SHAPES AND THE FURNITURE AROUND THEM. Pick by the question:
 *
 *   "how has this grown across the term?"   RunningTotalChart   (dated, cumulative)
 *   "how does each of these compare?"       BarRows             (unordered categories)
 *   "what happened on each of these?"       ColumnChart         (ordered categories)
 *   "what does the field look like?"        HistogramChart      (a number range)
 *   "how does this one thing divide?"       SplitBar            (a real total)
 *
 * The maths is in @/lib/charts and is pure and tested; these components draw
 * and do not compute. Each export documents at its definition what it takes,
 * which screen it is aimed at, what it does when handed nothing, and what it
 * deliberately refuses to do. Read ./figures.tsx's header for the house rules
 * they all obey.
 */
export {
  ChartFigure,
  ChartNote,
  MICRO,
  chartDay,
  clubDayOf,
  count,
  money,
} from './figures';
export { BarRows, ColumnChart, HistogramChart, SplitBar } from './shapes';
export { RUNNING_BOX, RunningTotalChart } from './running-total';
