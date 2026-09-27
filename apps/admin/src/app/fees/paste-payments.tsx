"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList } from "lucide-react";
import {
  Button,
  Checkbox,
  Dialog,
  Input,
  Select,
  Textarea,
} from "@badminton/ui";
import { resolvePaymentMethod } from "@badminton/shared";
import { useToast } from "@/components/toast-provider";
import {
  describeBulkOutcome,
  useBulkRun,
  type BulkRunResult,
} from "@/components/use-bulk-run";
import {
  bulkAddManualFees,
  bulkMarkFeesPaid,
  previewFeePaste,
} from "@/lib/actions";
import type { FeePastePreview } from "@/lib/fee-paste";
import {
  PaymentMethodFields,
  paymentMethodInvalid,
  EMPTY_PAYMENT_METHOD,
  type PaymentMethodState,
} from "./payment-method-fields";

/**
 * The season fee, settled from a pasted list.
 *
 * THE CASE THIS EXISTS FOR is the e-transfer inbox: thirty payments arrive as a
 * list of names and addresses, and the console had one row dialog per person.
 * The list is checked first and nothing is written until the exec has seen who
 * it will mark.
 *
 * THE WRITES ARE THE EXISTING ONES. Members go through bulkMarkFeesPaid, so each
 * is charged their own status rate exactly as the selection bar charges them;
 * people with no account can be kept as named payments through
 * bulkAddManualFees, which is addManualFee per row, so the payment moves onto
 * their account when they sign up with that email (00252). Keeping is off by
 * default: a name that matched nobody is as likely a typo as a stranger.
 */

interface KeepRow {
  keep: boolean;
  name: string;
  email: string;
  /** Dollars as typed. Blank means the batch price. */
  amount: string;
}

type Step = "input" | "preview" | "result";

interface NotMarked {
  label: string;
  reason: string;
}

const MAX_NAME = 80;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
        {title}{" "}
        <span className="font-mono text-xs text-[var(--text-muted)]">
          {count}
        </span>
      </h3>
      <ul className="space-y-1 text-sm text-[var(--text-secondary)]">
        {children}
      </ul>
    </section>
  );
}

export function PastePayments({
  seasonId,
  seasonName,
  competitiveFeeCents,
  recreationalFeeCents,
  canKeep,
}: {
  seasonId: string;
  seasonName: string;
  competitiveFeeCents: number;
  recreationalFeeCents: number;
  /** addmanual.write on the current season, the same test as Add a name. */
  canKeep: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { running, progress, run } = useBulkRun();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("input");
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<FeePastePreview | null>(null);
  const [keepRows, setKeepRows] = useState<KeepRow[]>([]);
  const [batchPrice, setBatchPrice] = useState<
    "" | "competitive" | "recreational"
  >("");
  const [payment, setPayment] =
    useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const [phase, setPhase] = useState<"marking" | "keeping" | null>(null);
  const [notMarked, setNotMarked] = useState<NotMarked[]>([]);

  function reset() {
    setStep("input");
    setText("");
    setPreview(null);
    setKeepRows([]);
    setBatchPrice("");
    setPayment(EMPTY_PAYMENT_METHOD);
    setNotMarked([]);
  }

  function close() {
    if (running || checking) return;
    setOpen(false);
    reset();
  }

  async function handleCheck() {
    setChecking(true);
    try {
      const result = await previewFeePaste({ season_id: seasonId, text });
      if (!result.ok) {
        toast(
          result.code
            ? `${result.error} (${result.code}.${result.ref})`
            : result.error,
          "error",
        );
        return;
      }
      setPreview(result.data);
      setKeepRows(
        result.data.notFound.map((n) => ({
          keep: false,
          name: (n.name ?? n.email ?? "").slice(0, MAX_NAME),
          email: n.email ?? "",
          amount: n.amountCents != null ? (n.amountCents / 100).toFixed(2) : "",
        })),
      );
      setStep("preview");
    } catch {
      toast("The list could not be checked. Try again.", "error");
    } finally {
      setChecking(false);
    }
  }

  const setRow = (i: number, patch: Partial<KeepRow>) =>
    setKeepRows((rows) =>
      rows.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    );

  const batchCents =
    batchPrice === "competitive"
      ? competitiveFeeCents
      : batchPrice === "recreational"
        ? recreationalFeeCents
        : null;

  // What each kept row would be recorded at: its own figure if it has one,
  // otherwise the batch price. Null means neither is set yet.
  function amountCentsOf(row: KeepRow): number | null {
    if (row.amount.trim() === "") return batchCents;
    const d = parseFloat(row.amount);
    return Number.isNaN(d) || d <= 0 ? null : Math.round(d * 100);
  }

  const kept = canKeep
    ? keepRows.map((r, i) => ({ row: r, i })).filter(({ row }) => row.keep)
    : [];
  const keepInvalid = kept.some(
    ({ row }) =>
      row.name.trim() === "" ||
      row.name.trim().length > MAX_NAME ||
      amountCentsOf(row) == null,
  );
  const needsBatchPrice = kept.some(({ row }) => row.amount.trim() === "");
  const willMarkCount = preview?.willMark.length ?? 0;

  async function handleConfirm() {
    if (!preview) return;
    const method = resolvePaymentMethod(payment.method, payment.customMethod);
    const reference = payment.reference.trim() || undefined;
    const missed: NotMarked[] = [];

    const willMarkIds = preview.willMark.map((w) => w.playerId);
    const nameOf = (id: string) =>
      preview.willMark.find((w) => w.playerId === id)?.fullName ?? id;
    if (willMarkIds.length > 0) {
      setPhase("marking");
      const res = await run(willMarkIds, (chunk) =>
        bulkMarkFeesPaid(chunk, seasonId, method, reference),
      );
      reportRun(res, "marked paid", nameOf);
      for (const f of res.outcome.failures)
        missed.push({ label: nameOf(f.id), reason: f.error });
      if (!res.ok) {
        for (const id of willMarkIds.slice(res.outcome.attempted)) {
          missed.push({
            label: nameOf(id),
            reason: `Not recorded: ${res.error ?? "the request failed"}`,
          });
        }
      }
    }

    // Ids are the kept rows' positions in `kept`, so a failure can be named.
    // Each call numbers its own entries from 0; the wrapper maps them back.
    const payloads = kept.map(({ row }) => ({
      manual_name: row.name.trim(),
      email: row.email.trim() || undefined,
      amount_cents: amountCentsOf(row) ?? undefined,
      method,
      reference,
    }));
    const keptIds = payloads.map((_, i) => String(i));
    const keptName = (id: string) => payloads[Number(id)]?.manual_name ?? id;
    if (keptIds.length > 0) {
      setPhase("keeping");
      const res = await run(keptIds, async (chunk) => {
        const r = await bulkAddManualFees(
          seasonId,
          chunk.map((id) => payloads[Number(id)]),
        );
        if (!r.ok) return r;
        return {
          ok: true as const,
          data: {
            ...r.data,
            failures: r.data.failures.map((f) => ({
              ...f,
              id: chunk[Number(f.id)] ?? f.id,
            })),
          },
        };
      });
      reportRun(res, "kept as named payments", keptName);
      for (const f of res.outcome.failures) {
        missed.push({
          label: keptName(f.id),
          reason: `Could not keep as a named payment: ${f.error}`,
        });
      }
      if (!res.ok) {
        for (const id of keptIds.slice(res.outcome.attempted)) {
          missed.push({
            label: keptName(id),
            reason: `Not kept: ${res.error ?? "the request failed"}`,
          });
        }
      }
    }
    setPhase(null);

    keepRows.forEach((row, i) => {
      if (canKeep && row.keep) return;
      const n = preview.notFound[i]!;
      missed.push({ label: n.raw, reason: "Not found on the roster" });
    });
    for (const a of preview.ambiguous)
      missed.push({ label: a.raw, reason: a.reason });
    for (const b of preview.notBillable)
      missed.push({
        label: b.raw.toLowerCase().includes(b.name.toLowerCase())
          ? b.raw
          : `${b.name} (${b.raw})`,
        reason: b.reason,
      });
    for (const v of preview.invalid)
      missed.push({ label: v.raw, reason: v.reason });

    setNotMarked(missed);
    setStep("result");
    if (willMarkIds.length + keptIds.length > 0) router.refresh();
  }

  function reportRun(
    res: BulkRunResult,
    verb: string,
    nameOf: (id: string) => string,
  ) {
    if (!res.ok) {
      const error = res.error ?? "Something went wrong";
      toast(res.code ? `${error} (${res.code}.${res.ref})` : error, "error");
      return;
    }
    const { message, type } = describeBulkOutcome(res.outcome, verb, nameOf);
    toast(message, type);
  }

  async function handleCopy() {
    const lines = [
      `Not marked paid for ${seasonName} (${notMarked.length}):`,
      ...notMarked.map((m) => `${m.label}: ${m.reason}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast("Copied", "success");
    } catch {
      toast("Could not copy. Select the list and copy it by hand.", "error");
    }
  }

  const busy = running
    ? `${phase === "keeping" ? "Keeping" : "Marking"} ${progress?.done ?? 0} of ${progress?.total ?? 0}…`
    : null;

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        className="border-[var(--border-hover)] text-[var(--text-primary)]"
      >
        <ClipboardList aria-hidden className="w-4 h-4" />
        Paste a list
      </Button>
      <Dialog open={open} onClose={close} title="Paste a list">
        {step === "input" && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              Paste who paid their{" "}
              <strong className="text-[var(--text-primary)]">
                {seasonName}
              </strong>{" "}
              fee: names, emails or both, one per line, or rows copied out of a
              spreadsheet. Nothing is recorded until you have checked the list.
            </p>
            <Textarea
              label="Names or emails"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                "Jane Doe <jane@sfu.ca>\nsam.lee@gmail.com, $25\nDoe, John"
              }
              disabled={checking}
            />
            <p className="text-xs text-[var(--text-muted)]">
              A long list takes a while to record. Keep this window open until
              it finishes.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close} disabled={checking}>
                Cancel
              </Button>
              <Button
                onClick={handleCheck}
                loading={checking}
                disabled={text.trim() === "" || text.length > 50000}
              >
                Check list
              </Button>
            </div>
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              Checked against{" "}
              <strong className="text-[var(--text-primary)]">
                {seasonName}
              </strong>
              . Each member is charged their own rate, competitive or
              recreational.
            </p>
            <div className="max-h-[60vh] overflow-y-auto space-y-4 pr-1">
              <Section
                title="Will be marked paid"
                count={preview.willMark.length}
              >
                {preview.willMark.map((w) => (
                  <li key={w.playerId}>
                    <span className="text-[var(--text-primary)]">
                      {w.fullName}
                    </span>
                    {w.email && (
                      <span className="text-[var(--text-muted)]">
                        {" "}
                        {w.email}
                      </span>
                    )}
                  </li>
                ))}
              </Section>
              <Section title="Already paid" count={preview.alreadyPaid.length}>
                {preview.alreadyPaid.map((r, i) => (
                  <li key={`${i}-${r.raw}`}>{r.name}</li>
                ))}
              </Section>
              <Section title="Waived" count={preview.waived.length}>
                {preview.waived.map((r, i) => (
                  <li key={`${i}-${r.raw}`}>{r.name}</li>
                ))}
              </Section>
              <Section
                title="Already recorded as a named payment"
                count={preview.alreadyNamed.length}
              >
                {preview.alreadyNamed.map((r, i) => (
                  <li key={`${i}-${r.raw}`}>{r.name}</li>
                ))}
              </Section>
              <Section
                title="Found but not marked"
                count={preview.notBillable.length}
              >
                {preview.notBillable.map((r, i) => (
                  <li key={`${i}-${r.raw}`}>
                    {r.name}:{" "}
                    <span className="text-[var(--text-muted)]">{r.reason}</span>
                  </li>
                ))}
              </Section>
              <Section title="Ambiguous" count={preview.ambiguous.length}>
                {preview.ambiguous.map((a, i) => (
                  <li key={`${i}-${a.raw}`}>
                    <span className="text-[var(--text-primary)]">{a.raw}</span>:{" "}
                    <span className="text-[var(--text-muted)]">
                      {a.reason} Could be{" "}
                      {a.candidates
                        .map((c) =>
                          c.maskedEmail
                            ? `${c.name} (${c.maskedEmail})`
                            : c.name,
                        )
                        .join(" or ")}
                      .
                    </span>
                  </li>
                ))}
              </Section>
              <Section title="Not found" count={preview.notFound.length}>
                {preview.notFound.map((n, i) => {
                  const row = keepRows[i]!;
                  const hint = n.email == null && n.possibleMembers.length > 0;
                  const who = n.possibleMembers.join(" or ");
                  return (
                    <li
                      key={`${i}-${n.raw}`}
                      className="space-y-2 border-b border-[var(--border)] pb-2 last:border-b-0"
                    >
                      <span className="text-[var(--text-primary)]">
                        {n.raw}
                      </span>
                      {hint && (
                        <p className="text-xs text-[var(--color-warning)]">
                          Might be {who}. Keeping this may count the payment
                          twice if you later mark{" "}
                          {n.possibleMembers.length === 1 ? who : "one of them"}{" "}
                          paid.
                        </p>
                      )}
                      {canKeep && (
                        <>
                          <Checkbox
                            checked={row.keep}
                            onChange={(checked) => setRow(i, { keep: checked })}
                            label="Keep as a named payment"
                            showLabel
                            disabled={running}
                          />
                          {row.keep && (
                            <div className="grid gap-2 sm:grid-cols-3">
                              <Input
                                label="Name"
                                value={row.name}
                                maxLength={MAX_NAME}
                                onChange={(e) =>
                                  setRow(i, { name: e.target.value })
                                }
                                disabled={running}
                              />
                              <Input
                                label="Email"
                                type="email"
                                autoComplete="off"
                                value={row.email}
                                onChange={(e) =>
                                  setRow(i, { email: e.target.value })
                                }
                                disabled={running}
                              />
                              <Input
                                label="Amount $"
                                type="number"
                                step="0.01"
                                min="0"
                                value={row.amount}
                                onChange={(e) =>
                                  setRow(i, { amount: e.target.value })
                                }
                                placeholder={
                                  batchCents != null
                                    ? (batchCents / 100).toFixed(2)
                                    : "Batch price"
                                }
                                disabled={running}
                              />
                              {row.email.trim() === "" && (
                                <p className="text-xs text-[var(--text-muted)] sm:col-span-3">
                                  Without an email this stays a named payment.
                                  With one, it moves onto their account when
                                  they sign up with that email.
                                </p>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </Section>
              <Section title="Could not read" count={preview.invalid.length}>
                {preview.invalid.map((v, i) => (
                  <li key={`${i}-${v.raw}`}>
                    <span className="text-[var(--text-primary)]">{v.raw}</span>:{" "}
                    <span className="text-[var(--text-muted)]">{v.reason}</span>
                  </li>
                ))}
              </Section>
            </div>

            {preview.notFound.length > 0 && !canKeep && (
              <p className="text-xs text-[var(--text-muted)]">
                Keeping a name as a named payment needs the current season, and
                permission to add names.
              </p>
            )}
            {canKeep && needsBatchPrice && (
              <Select
                label="Price for kept payments with no amount"
                options={[
                  { value: "", label: "Choose a price" },
                  {
                    value: "competitive",
                    label: `Competitive ${dollars(competitiveFeeCents)}`,
                  },
                  {
                    value: "recreational",
                    label: `Recreational ${dollars(recreationalFeeCents)}`,
                  },
                ]}
                value={batchPrice}
                onChange={(e) =>
                  setBatchPrice(e.target.value as typeof batchPrice)
                }
                disabled={running}
              />
            )}
            <PaymentMethodFields
              value={payment}
              onChange={setPayment}
              disabled={running}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setStep("input")}
                disabled={running}
              >
                Back
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={
                  running || keepInvalid || paymentMethodInvalid(payment)
                }
              >
                {busy ??
                  (willMarkCount + kept.length === 0
                    ? "Nothing to record, show the list"
                    : `Mark ${willMarkCount} paid, keep ${kept.length}`)}
              </Button>
            </div>
          </div>
        )}

        {step === "result" && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              {notMarked.length === 0
                ? `Everyone on the list is accounted for in ${seasonName}.`
                : `${notMarked.length} on the list ${notMarked.length === 1 ? "was" : "were"} not marked paid for ${seasonName}.`}
            </p>
            {!canKeep && (preview?.notFound.length ?? 0) > 0 && (
              <p className="text-xs text-[var(--text-muted)]">
                Keeping a name as a named payment needs the current season.
                Switch to it on this page to keep them.
              </p>
            )}
            {notMarked.length > 0 && (
              <ul className="max-h-[60vh] overflow-y-auto space-y-1 text-sm text-[var(--text-secondary)]">
                {notMarked.map((m, i) => (
                  <li key={`${i}-${m.label}`}>
                    <span className="text-[var(--text-primary)]">
                      {m.label}
                    </span>
                    :{" "}
                    <span className="text-[var(--text-muted)]">{m.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              {notMarked.length > 0 && (
                <Button variant="secondary" onClick={handleCopy}>
                  Copy list
                </Button>
              )}
              <Button onClick={close}>Done</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
