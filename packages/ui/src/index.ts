export * from './components';
// Re-exported from the root so every existing `from '@badminton/ui'` import
// keeps working: the matching moved out of PlayerPicker.tsx into its own
// React-free module, and no caller should have to care.
export { filterPlayerOptions, filterRowsByPlayers, normalizeSearchQuery } from './player-search';
export {
  toSelectedIds,
  toSingleValue,
  addSelectedId,
  removeSelectedId,
  selectableOptions,
  selectedOptions,
} from './player-selection';
// The same arrangement as the block above, for the same reason: MultiSelect's
// set arithmetic lives in a React-free module so it can be tested without
// rendering, and no caller should have to know which file it came out of.
export {
  filterMultiSelectOptions,
  groupMultiSelectOptions,
  identifiedOptions,
  toggleValue,
  type MultiSelectOption,
} from './multi-select';
export { useLiveChannel, type RecoverableChannel } from './use-live-channel';
export { cn } from './utils';
