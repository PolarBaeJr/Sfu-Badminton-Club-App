'use client';

import { Input, Select } from '@badminton/ui';
import { PAYMENT_METHODS, PAYMENT_METHOD_CUSTOM, isReservedMethod } from '@badminton/shared';

export interface PaymentMethodState {
  method: string;
  customMethod: string;
  reference: string;
}

export const EMPTY_PAYMENT_METHOD: PaymentMethodState = {
  method: '',
  customMethod: '',
  reference: '',
};

// One component for all three "mark paid" dialogs — season fee, manual name,
// and tournament fee. They had three copies of the same free-text box, which is
// how they drifted apart in placeholder text; a shared component means the
// vocabulary can only ever change in one place.
export function PaymentMethodFields({
  value,
  onChange,
  disabled,
}: {
  value: PaymentMethodState;
  onChange: (next: PaymentMethodState) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<PaymentMethodState>) => onChange({ ...value, ...patch });

  const customIsReserved =
    value.method === PAYMENT_METHOD_CUSTOM && isReservedMethod(value.customMethod);

  return (
    <>
      <Select
        label="Method (optional)"
        options={[{ value: '', label: '—' }, ...PAYMENT_METHODS.map((m) => ({ ...m }))]}
        value={value.method}
        disabled={disabled}
        onChange={(e) =>
          set({
            method: e.target.value,
            // Drop any typed text when moving off Custom, so a stale value
            // can't be submitted with a different method selected.
            customMethod: e.target.value === PAYMENT_METHOD_CUSTOM ? value.customMethod : '',
          })
        }
      />

      {value.method === PAYMENT_METHOD_CUSTOM && (
        <Input
          label="Custom method"
          value={value.customMethod}
          disabled={disabled}
          onChange={(e) => set({ customMethod: e.target.value })}
          placeholder="e.g. cheque"
          // 'waived' is how a waiver is stored, so accepting it here would make
          // the row render as Waived and drop out of the outstanding count.
          error={customIsReserved ? '"waived" is reserved — use Skip (Waive) instead' : undefined}
        />
      )}

      <Input
        label="Transaction ID (optional)"
        value={value.reference}
        disabled={disabled}
        onChange={(e) => set({ reference: e.target.value })}
        placeholder="e.g. confirmation or receipt number"
      />
    </>
  );
}

/** True when the dialog's submit button should stay disabled. */
export function paymentMethodInvalid(value: PaymentMethodState): boolean {
  return value.method === PAYMENT_METHOD_CUSTOM && isReservedMethod(value.customMethod);
}
