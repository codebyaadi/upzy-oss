import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { createContext, useContext, type ReactNode } from "react";

/** Where the web app is served from: the logo is fetched from there (email clients can't show inline SVG). */
export const EmailContext = createContext({ appUrl: "http://localhost:3001" });

/** The brand, as in the app and the website (packages/ui globals.css). Email clients ignore CSS variables, so these are literals. */
export const color = {
  page: "#f4f6f3",
  card: "#ffffff",
  ink: "#14181a",
  muted: "#5b6663",
  line: "#e2e8e4",
  primary: "#0f3d3a",
  brand: "#0f7a6a",
  tint: "#e6f3ef",
};
const font = "Sora, 'Segoe UI', -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";

const styles = {
  h1: {
    fontFamily: font,
    fontSize: "22px",
    lineHeight: "30px",
    fontWeight: 700,
    color: color.ink,
    margin: "0 0 16px",
  },
  p: {
    fontFamily: font,
    fontSize: "15px",
    lineHeight: "24px",
    color: color.ink,
    margin: "0 0 16px",
  },
  muted: {
    fontFamily: font,
    fontSize: "13px",
    lineHeight: "20px",
    color: color.muted,
    margin: "0 0 12px",
  },
};

export const H1 = ({ children }: { children: ReactNode }) => (
  <Text style={styles.h1}>{children}</Text>
);
export const P = ({ children }: { children: ReactNode }) => (
  <Text style={styles.p}>{children}</Text>
);
export const Muted = ({ children }: { children: ReactNode }) => (
  <Text style={styles.muted}>{children}</Text>
);

export const Cta = ({ href, children }: { href: string; children: ReactNode }) => (
  <Section style={{ margin: "24px 0" }}>
    <Button
      href={href}
      style={{
        backgroundColor: color.primary,
        color: "#ffffff",
        fontFamily: font,
        fontSize: "15px",
        fontWeight: 600,
        borderRadius: "999px",
        padding: "12px 24px",
        textDecoration: "none",
        display: "inline-block",
      }}
    >
      {children}
    </Button>
  </Section>
);

/** A call-out for the one thing the email is about (a finding, an incident headline). */
export const Callout = ({ children }: { children: ReactNode }) => (
  <Section
    style={{
      backgroundColor: color.tint,
      borderRadius: "16px",
      padding: "14px 18px",
      margin: "0 0 20px",
    }}
  >
    {children}
  </Section>
);

/** The logo as on the website: the mark on a deep-teal tile, then the wordmark with its brand-colour full stop. */
function Brand() {
  const { appUrl } = useContext(EmailContext);
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ margin: "0 0 18px 4px" }}>
      <tbody>
        <tr>
          <td style={{ paddingRight: "10px", verticalAlign: "middle" }}>
            <Img
              src={`${appUrl.replace(/\/$/, "")}/email/logo.png`}
              width={36}
              height={36}
              alt="Upzy"
              style={{
                display: "block",
                width: "36px",
                height: "36px",
                maxWidth: "36px",
                border: 0,
                borderRadius: "10px",
              }}
            />
          </td>
          <td style={{ verticalAlign: "middle" }}>
            <span
              style={{
                fontFamily: font,
                fontSize: "22px",
                fontWeight: 800,
                letterSpacing: "-0.04em",
                color: color.primary,
              }}
            >
              Upzy<span style={{ color: color.brand }}>.</span>
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** The shared frame: wordmark, white card on the app's pale background, footer. */
export function Layout({
  preview,
  unsubscribeUrl,
  footer,
  children,
}: {
  preview: string;
  unsubscribeUrl?: string;
  /** Why this reached them, when it isn't obvious. */
  footer?: string;
  children: ReactNode;
}) {
  return (
    <Html lang="en">
      <Head>
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap"
          rel="stylesheet"
        />
      </Head>
      <Preview>{preview}</Preview>
      <Body
        style={{ backgroundColor: color.page, margin: 0, padding: "32px 12px", fontFamily: font }}
      >
        <Container style={{ maxWidth: "540px", margin: "0 auto" }}>
          <Brand />
          <Section
            style={{
              backgroundColor: color.card,
              border: `1px solid ${color.line}`,
              borderRadius: "24px",
              padding: "32px 28px 16px",
            }}
          >
            {children}
          </Section>
          <Hr style={{ borderColor: "transparent", margin: "8px 0" }} />
          {footer ? <Text style={{ ...styles.muted, margin: "0 4px 4px" }}>{footer}</Text> : null}
          {unsubscribeUrl ? (
            <Text style={{ ...styles.muted, margin: "0 4px" }}>
              Don&apos;t want these?{" "}
              <Link href={unsubscribeUrl} style={{ color: color.brand }}>
                Unsubscribe
              </Link>
              . Alerts and account emails still arrive.
            </Text>
          ) : null}
        </Container>
      </Body>
    </Html>
  );
}
