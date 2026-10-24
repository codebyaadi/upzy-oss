"use client";

import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";

import { SelectField } from "@/components/app/select-field";
import { Field } from "@/components/app/ui";
import { api } from "@/lib/api";
import {
  emptyBrowserStep,
  emptyStep,
  type BrowserAction,
  type BrowserStepDraft,
  type AssertionRow,
  type Draft,
  type Pair,
  type SecretRow,
  type StepDraft,
} from "@/lib/monitor-form";
import { unwrap, useApi } from "@/lib/use-api";

const AREA =
  "border-input focus-visible:ring-ring w-full resize-y rounded-2xl border bg-transparent px-4 py-3 font-mono text-xs outline-hidden focus-visible:ring-1";

function RowButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}

/** Rows of name + value, for headers and for the variables a step reads from a response. */
export function PairRows({
  rows,
  onChange,
  nameLabel,
  valueLabel,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
  nameLabel: string;
  valueLabel: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  const set = (i: number, patch: Partial<Pair>) =>
    onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2">
          <Input
            aria-label={`${nameLabel} ${i + 1}`}
            value={r.name}
            placeholder={namePlaceholder}
            onChange={(e) => set(i, { name: e.target.value })}
          />
          <Input
            aria-label={`${valueLabel} ${i + 1}`}
            value={r.value}
            placeholder={valuePlaceholder}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <RowButton onClick={() => onChange(rows.filter((_, n) => n !== i))}>Remove</RowButton>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { name: "", value: "" }])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

const OPS: { value: AssertionRow["op"]; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "doesn't equal" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "exists" },
  { value: "not_exists", label: "is missing" },
  { value: "gt", label: "is greater than" },
  { value: "lt", label: "is less than" },
];

/** Checks on the JSON a response returns: path, comparison, value. */
export function AssertionRows({
  rows,
  onChange,
}: {
  rows: AssertionRow[];
  onChange: (rows: AssertionRow[]) => void;
}) {
  const set = (i: number, patch: Partial<AssertionRow>) =>
    onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1.2fr_1fr_1fr_auto] items-center gap-2">
          <Input
            aria-label={`JSON path ${i + 1}`}
            value={r.path}
            placeholder="data.status"
            onChange={(e) => set(i, { path: e.target.value })}
          />
          <SelectField
            aria-label={`Comparison ${i + 1}`}
            value={r.op}
            onValueChange={(op) => set(i, { op })}
            options={OPS}
          />
          {r.op === "exists" || r.op === "not_exists" ? (
            <span />
          ) : (
            <Input
              aria-label={`Value ${i + 1}`}
              value={r.value}
              placeholder="ok"
              onChange={(e) => set(i, { value: e.target.value })}
            />
          )}
          <RowButton onClick={() => onChange(rows.filter((_, n) => n !== i))}>Remove</RowButton>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { path: "", op: "equals", value: "" }])}
      >
        Add a check
      </Button>
    </div>
  );
}

/** Write-only secrets: stored encrypted, never shown again. Blank on a stored one means "keep it". */
export function SecretFields({
  rows,
  onChange,
}: {
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
}) {
  const set = (i: number, patch: Partial<SecretRow>) =>
    onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2">
          <Input
            aria-label={`Secret name ${i + 1}`}
            value={r.name}
            disabled={r.stored}
            placeholder="API_TOKEN"
            onChange={(e) =>
              set(i, { name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })
            }
          />
          <Input
            aria-label={`Secret value ${i + 1}`}
            type="password"
            autoComplete="off"
            value={r.value}
            placeholder={r.stored ? "•••••• kept (type to replace)" : "the secret value"}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <RowButton onClick={() => onChange(rows.filter((_, n) => n !== i))}>Remove</RowButton>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { name: "", value: "", stored: false }])}
      >
        Add a secret
      </Button>
      <p className="text-muted-foreground text-xs">
        Use one in a header, body or address as{" "}
        <code className="font-mono">{"{{secret.NAME}}"}</code>, for example{" "}
        <code className="font-mono">{"Bearer {{secret.API_TOKEN}}"}</code>. Values are stored
        encrypted and can&apos;t be read back.
      </p>
    </div>
  );
}

const ACTIONS: { value: BrowserAction; label: string }[] = [
  { value: "click", label: "Click" },
  { value: "fill", label: "Type into a field" },
  { value: "press", label: "Press a key" },
  { value: "wait_for", label: "Wait for something to appear" },
  { value: "expect_text", label: "Expect this text" },
  { value: "expect_url", label: "Expect the address to contain" },
  { value: "goto", label: "Open another page" },
  { value: "wait", label: "Wait a moment" },
];

/**
 * What a visitor does on the page, one row at a time. The page in "Target" opens first. Rows are plain choices:
 * nothing here runs code.
 */
export function BrowserSteps({ d, set }: { d: Draft; set: (patch: Partial<Draft>) => void }) {
  const setRow = (i: number, patch: Partial<BrowserStepDraft>) =>
    set({ browser: d.browser.map((r, n) => (n === i ? { ...r, ...patch } : r)) });
  const move = (i: number, by: -1 | 1) => {
    const next = [...d.browser];
    const [row] = next.splice(i, 1);
    next.splice(i + by, 0, row!);
    set({ browser: next });
  };
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        The target opens first. Then, in order, add what a visitor does and what they should see. If
        a step can&apos;t be done within 10 seconds the check fails and says which one.
      </p>
      {d.browser.map((r, i) => (
        <fieldset key={i} className="space-y-3 rounded-2xl border p-4">
          <legend className="px-2 text-sm font-semibold">Step {i + 1}</legend>
          <Field label="Action" htmlFor={`b-${i}-do`}>
            <SelectField
              id={`b-${i}-do`}
              value={r.do}
              onValueChange={(action) => setRow(i, { do: action })}
              options={ACTIONS}
            />
          </Field>
          {r.do === "goto" && (
            <Field label="Address" htmlFor={`b-${i}-url`}>
              <Input
                id={`b-${i}-url`}
                value={r.url}
                placeholder="https://example.com/account"
                onChange={(e) => setRow(i, { url: e.target.value })}
              />
            </Field>
          )}
          {(r.do === "click" ||
            r.do === "fill" ||
            r.do === "wait_for" ||
            r.do === "expect_text") && (
            <Field
              label={r.do === "expect_text" ? "Inside (optional)" : "Which element"}
              htmlFor={`b-${i}-sel`}
              hint={
                r.do === "expect_text"
                  ? "A selector to look in. Empty: anywhere on the page."
                  : "A CSS selector like #email or button[type=submit], or text=Sign in."
              }
            >
              <Input
                id={`b-${i}-sel`}
                value={r.selector}
                maxLength={200}
                onChange={(e) => setRow(i, { selector: e.target.value })}
              />
            </Field>
          )}
          {r.do === "fill" && (
            <Field
              label="Text"
              htmlFor={`b-${i}-value`}
              hint="Use {{secret.NAME}} for a password; it is typed but never shown."
            >
              <Input
                id={`b-${i}-value`}
                value={r.value}
                maxLength={500}
                placeholder="{{secret.TEST_PASSWORD}}"
                onChange={(e) => setRow(i, { value: e.target.value })}
              />
            </Field>
          )}
          {r.do === "press" && (
            <Field label="Key" htmlFor={`b-${i}-key`}>
              <SelectField
                id={`b-${i}-key`}
                value={r.key}
                onValueChange={(key) => setRow(i, { key })}
                options={["Enter", "Tab", "Escape"].map((k) => ({ value: k as "Enter", label: k }))}
              />
            </Field>
          )}
          {r.do === "expect_text" && (
            <Field label="Text" htmlFor={`b-${i}-text`}>
              <Input
                id={`b-${i}-text`}
                value={r.text}
                maxLength={200}
                placeholder="Welcome back"
                onChange={(e) => setRow(i, { text: e.target.value })}
              />
            </Field>
          )}
          {r.do === "expect_url" && (
            <Field label="Contains" htmlFor={`b-${i}-contains`}>
              <Input
                id={`b-${i}-contains`}
                value={r.contains}
                maxLength={200}
                placeholder="/dashboard"
                onChange={(e) => setRow(i, { contains: e.target.value })}
              />
            </Field>
          )}
          {r.do === "wait" && (
            <Field label="Milliseconds" htmlFor={`b-${i}-ms`} hint="Between 100 and 5000.">
              <Input
                id={`b-${i}-ms`}
                inputMode="numeric"
                value={r.ms}
                onChange={(e) => setRow(i, { ms: e.target.value.replace(/[^0-9]/g, "") })}
              />
            </Field>
          )}
          <div className="flex gap-1">
            <RowButton onClick={() => i > 0 && move(i, -1)}>Move up</RowButton>
            <RowButton onClick={() => i < d.browser.length - 1 && move(i, 1)}>Move down</RowButton>
            <RowButton onClick={() => set({ browser: d.browser.filter((_, n) => n !== i) })}>
              Remove
            </RowButton>
          </div>
        </fieldset>
      ))}
      {d.browser.length < 20 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => set({ browser: [...d.browser, emptyBrowserStep()] })}
        >
          Add a step
        </Button>
      )}
      <div className="space-y-2">
        <p className="text-sm font-semibold">Secrets</p>
        <SecretFields rows={d.secrets} onChange={(secrets) => set({ secrets })} />
      </div>
    </div>
  );
}

/** Method, headers, body and JSON checks for an HTTP monitor. */
export function HttpOptions({ d, set }: { d: Draft; set: (patch: Partial<Draft>) => void }) {
  return (
    <details
      className="rounded-2xl border p-4"
      open={!!(d.headers.length || d.assertions.length || d.method !== "GET")}
    >
      <summary className="cursor-pointer text-sm font-semibold">
        Advanced: method, headers, JSON checks, secrets
      </summary>
      <div className="mt-4 space-y-5">
        <Field
          label="Method"
          htmlFor="method"
          hint="POST can send a body; HEAD can't check the response text."
        >
          <SelectField
            id="method"
            value={d.method}
            onValueChange={(method) => set({ method })}
            options={[
              { value: "GET", label: "GET" },
              { value: "POST", label: "POST" },
              { value: "HEAD", label: "HEAD" },
            ]}
          />
        </Field>
        <Field
          label="Headers"
          htmlFor="header-1"
          hint="Sent with every check, for example Accept or X-App-Version."
        >
          <PairRows
            rows={d.headers}
            onChange={(headers) => set({ headers })}
            nameLabel="Header name"
            valueLabel="Header value"
            namePlaceholder="Authorization"
            valuePlaceholder="Bearer {{secret.API_TOKEN}}"
            addLabel="Add a header"
          />
        </Field>
        {d.method === "POST" && (
          <Field
            label="Body"
            htmlFor="body"
            hint="Sent as JSON if it looks like JSON, otherwise as text."
          >
            <textarea
              id="body"
              rows={4}
              maxLength={10000}
              className={AREA}
              value={d.body}
              onChange={(e) => set({ body: e.target.value })}
              placeholder='{"ping": true}'
            />
          </Field>
        )}
        {d.method !== "HEAD" && (
          <Field
            label="Checks on the JSON response"
            htmlFor="assert-1"
            hint="The check fails unless every one passes. Use dots and [0] for lists, like data.items[0].status."
          >
            <AssertionRows rows={d.assertions} onChange={(assertions) => set({ assertions })} />
          </Field>
        )}
        <Field label="Secrets" htmlFor="secret-1">
          <SecretFields rows={d.secrets} onChange={(secrets) => set({ secrets })} />
        </Field>
      </div>
    </details>
  );
}

/** Up to five requests in order; later ones can use values read from earlier responses. */
export function FlowSteps({ d, set }: { d: Draft; set: (patch: Partial<Draft>) => void }) {
  const setStep = (i: number, patch: Partial<StepDraft>) =>
    set({ steps: d.steps.map((s, n) => (n === i ? { ...s, ...patch } : s)) });
  return (
    <div className="space-y-4">
      {d.steps.map((s, i) => (
        <fieldset key={i} className="space-y-4 rounded-2xl border p-4">
          <legend className="px-2 text-sm font-semibold">Step {i + 1}</legend>
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <Field label="Name" htmlFor={`step-${i}-name`}>
              <Input
                id={`step-${i}-name`}
                value={s.name}
                maxLength={60}
                placeholder={i === 0 ? "Log in" : "Fetch profile"}
                onChange={(e) => setStep(i, { name: e.target.value })}
              />
            </Field>
            <Field label="Method" htmlFor={`step-${i}-method`}>
              <SelectField
                id={`step-${i}-method`}
                value={s.method}
                onValueChange={(method) => setStep(i, { method })}
                options={[
                  { value: "GET", label: "GET" },
                  { value: "POST", label: "POST" },
                ]}
              />
            </Field>
          </div>
          <Field
            label="Address"
            htmlFor={`step-${i}-url`}
            hint={i === 0 ? undefined : "You can use values from earlier steps: {{userId}}."}
          >
            <Input
              id={`step-${i}-url`}
              value={s.url}
              placeholder="https://api.example.com/login"
              onChange={(e) => setStep(i, { url: e.target.value })}
            />
          </Field>
          <Field label="Headers" htmlFor={`step-${i}-h`}>
            <PairRows
              rows={s.headers}
              onChange={(headers) => setStep(i, { headers })}
              nameLabel={`Step ${i + 1} header name`}
              valueLabel={`Step ${i + 1} header value`}
              namePlaceholder="Authorization"
              valuePlaceholder="Bearer {{token}}"
              addLabel="Add a header"
            />
          </Field>
          {s.method === "POST" && (
            <Field label="Body" htmlFor={`step-${i}-body`}>
              <textarea
                id={`step-${i}-body`}
                rows={3}
                maxLength={10000}
                className={AREA}
                value={s.body}
                onChange={(e) => setStep(i, { body: e.target.value })}
                placeholder='{"user":"probe","password":"{{secret.PASSWORD}}"}'
              />
            </Field>
          )}
          <Field label="Checks on the response" htmlFor={`step-${i}-a`}>
            <AssertionRows
              rows={s.assertions}
              onChange={(assertions) => setStep(i, { assertions })}
            />
          </Field>
          <Field
            label="Read values for later steps"
            htmlFor={`step-${i}-x`}
            hint="Name a value and say where it is in the JSON, for example token = data.token."
          >
            <PairRows
              rows={s.extract}
              onChange={(extract) => setStep(i, { extract })}
              nameLabel={`Step ${i + 1} variable`}
              valueLabel={`Step ${i + 1} JSON path`}
              namePlaceholder="token"
              valuePlaceholder="data.token"
              addLabel="Read a value"
            />
          </Field>
          {d.steps.length > 1 && (
            <RowButton onClick={() => set({ steps: d.steps.filter((_, n) => n !== i) })}>
              Remove step {i + 1}
            </RowButton>
          )}
        </fieldset>
      ))}
      {d.steps.length < 5 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => set({ steps: [...d.steps, emptyStep()] })}
        >
          Add a step
        </Button>
      )}
      <Field label="Secrets" htmlFor="secret-1">
        <SecretFields rows={d.secrets} onChange={(secrets) => set({ secrets })} />
      </Field>
    </div>
  );
}

const EVERY = [
  [60, "1 minute"],
  [300, "5 minutes"],
  [900, "15 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
  [21600, "6 hours"],
  [43200, "12 hours"],
  [86400, "1 day"],
  [604800, "1 week"],
] as const;
const GRACE = [
  [60, "1 minute"],
  [300, "5 minutes"],
  [900, "15 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
  [7200, "2 hours"],
  [21600, "6 hours"],
] as const;

/** How often the job should check in, and how late it may be. */
export function HeartbeatFields({ d, set }: { d: Draft; set: (patch: Partial<Draft>) => void }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="The job should check in every" htmlFor="expectEvery">
        <SelectField
          id="expectEvery"
          value={d.expectEvery}
          onValueChange={(expectEvery) => set({ expectEvery })}
          options={EVERY.map(([v, label]) => ({ value: String(v), label }))}
        />
      </Field>
      <Field
        label="Allow it to be late by"
        htmlFor="grace"
        hint="Runs take time. Alert only after this much extra."
      >
        <SelectField
          id="grace"
          value={d.grace}
          onValueChange={(grace) => set({ grace })}
          options={[
            { value: "auto", label: "Automatic (10% of the period)" },
            ...GRACE.map(([v, label]) => ({ value: String(v), label })),
          ]}
        />
      </Field>
    </div>
  );
}

/**
 * Where to check from. Only shown when the installation has more than one place to offer. Picking none means the
 * main server; picking several means the monitor counts as down only when most of them agree.
 */
export function RegionPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (regions: string[]) => void;
}) {
  const offered = useApi("monitor-regions", () => unwrap(api.monitor.regions.get()));
  const list = offered.data?.regions ?? [];
  const max = offered.data?.max ?? null;
  if (list.length < 2) return null;
  const label = (r: string) => (r === "local" ? "Main server" : r);
  const toggle = (r: string) =>
    onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r]);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">Check from</legend>
      <div className="flex flex-wrap gap-2">
        {list.map((r) => {
          const on = value.includes(r);
          const full = !on && max !== null && value.length >= max;
          return (
            <label
              key={r}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${on ? "bg-accent border-transparent font-semibold" : ""} ${full ? "opacity-50" : "cursor-pointer"}`}
            >
              <input
                type="checkbox"
                className="size-4"
                checked={on}
                disabled={full}
                onChange={() => toggle(r)}
              />
              {label(r)}
            </label>
          );
        })}
      </div>
      <p className="text-muted-foreground text-xs">
        {value.length === 0
          ? "Nothing selected: checked from the main server."
          : value.length === 1
            ? "Checked from one place."
            : "Down only when most of these places can't reach it, so one region's network trouble doesn't wake you up."}
        {max !== null && ` Your plan allows ${max} at once.`}
      </p>
    </fieldset>
  );
}
