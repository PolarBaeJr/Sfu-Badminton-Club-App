/**
 * Compile-time tests. There is nothing to run here — `tsc --noEmit` IS the
 * assertion, and every `@ts-expect-error` below fails the build the moment the
 * error it expects stops happening.
 *
 * What it guards: PlayerPicker's props are a discriminated union so that a
 * single-select picker cannot be handed a list. That claim is easy to make and
 * easy to lose (one `value: string | string[]` in the base props and the whole
 * thing silently degrades to a runtime concern). Written as types rather than
 * as a .test.ts because there is no runtime behaviour to observe: the guarantee
 * either exists in the type or does not exist at all.
 *
 * Named .types.ts, not .test.ts, so vitest ignores it and tsc does not.
 */
import type { PlayerPickerProps } from '@badminton/ui';

const players = [{ id: 'p1', name: 'Alice Chen' }];

// A single picker, unchanged from how all five single-select call sites write
// it — no `multiple` prop at all.
export const singleOk: PlayerPickerProps = {
  players,
  value: 'p1',
  onChange: (id: string) => void id,
};

// The multi form.
export const multiOk: PlayerPickerProps = {
  multiple: true,
  players,
  value: ['p1'],
  onChange: (ids: string[]) => void ids,
};

// A list handed to a picker that never said `multiple`. This is the mistake the
// union exists to catch — the tournament "Add Participant" dialog holds both
// shapes a few lines apart.
//
// The directives sit on the DECLARATION, not on the offending property: an
// object literal checked against a union is rejected as a whole, so that is
// where tsc reports it.
//
// @ts-expect-error string[] is not a single selection
export const arrayIntoSingle: PlayerPickerProps = {
  players,
  value: ['p1'],
  onChange: (id: string) => void id,
};

// The mirror image: a lone id on a multi picker.
// @ts-expect-error a multi picker's value is a list
export const stringIntoMulti: PlayerPickerProps = {
  multiple: true,
  players,
  value: 'p1',
  onChange: (ids: string[]) => void ids,
};

// `multiple` with a single-valued onChange — the half-converted call site.
// @ts-expect-error a multi picker hands back the whole list
export const multiWithSingleHandler: PlayerPickerProps = {
  multiple: true,
  players,
  value: ['p1'],
  onChange: (id: string) => void id,
};
