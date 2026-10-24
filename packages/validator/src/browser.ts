import z from "zod";

/*
 * A browser monitor is a short list of things a visitor does: open a page, click, type, and what they should then
 * see. It is data, never code, so there is nothing a customer can run on the machine that runs the browser.
 */

/** A CSS, text= or role= selector as Playwright reads it. */
const Selector = z.string().trim().min(1).max(200);

export const BrowserStepSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("goto"), url: z.string().max(2000) }),
  z.object({ do: z.literal("click"), selector: Selector }),
  /** The text may use {{secret.NAME}}, so a test account's password never sits in the steps. */
  z.object({ do: z.literal("fill"), selector: Selector, value: z.string().max(500) }),
  z.object({ do: z.literal("press"), key: z.enum(["Enter", "Tab", "Escape"]) }),
  z.object({ do: z.literal("wait_for"), selector: Selector }),
  z.object({
    do: z.literal("expect_text"),
    text: z.string().min(1).max(200),
    selector: Selector.optional(),
  }),
  z.object({ do: z.literal("expect_url"), contains: z.string().min(1).max(200) }),
  z.object({ do: z.literal("wait"), ms: z.number().int().min(100).max(5000) }),
]);
export type BrowserStep = z.infer<typeof BrowserStepSchema>;

export const MAX_BROWSER_STEPS = 20;

/** The one-line description of a step, as shown in results and error messages. */
export function describeStep(s: BrowserStep): string {
  switch (s.do) {
    case "goto":
      return `open ${s.url}`;
    case "click":
      return `click ${s.selector}`;
    case "fill":
      return `type into ${s.selector}`;
    case "press":
      return `press ${s.key}`;
    case "wait_for":
      return `wait for ${s.selector}`;
    case "expect_text":
      return `expect the text "${s.text}"${s.selector ? ` in ${s.selector}` : ""}`;
    case "expect_url":
      return `expect the address to contain "${s.contains}"`;
    case "wait":
      return `wait ${s.ms} ms`;
  }
}
