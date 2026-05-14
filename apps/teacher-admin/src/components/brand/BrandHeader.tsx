// Shared page header used across student + dashboard + admin surfaces.
//
// Editorial layout — logo on the left, hairline maroon rule below, optional
// small-caps eyebrow + title + italic subtitle on the right. Logo is the
// canonical EHS horizontal mark from /public/brand. Never alter colors or
// proportions per the style guide.

/* eslint-disable @next/next/no-img-element -- /public asset, no Next image
 * optimization needed and the actual pixel dimensions vary by render context. */

import Link from "next/link";

type Props = {
  /** Small-caps line above the title. e.g. "AI Use Reflection". */
  eyebrow?: string;
  /** Main title in body weight. e.g. an assignment name. */
  title?: string;
  /** Italic subtitle below the title. e.g. course name. */
  subtitle?: string;
  /** Optional right-side slot (sign-out button, admin badge, etc). */
  right?: React.ReactNode;
  /** When provided, makes the logo a link back to this path. Don't wrap the
   * whole header — `right` is typically a `<nav>` with its own anchors, and
   * nested `<a>` tags are invalid HTML. */
  logoHref?: string;
  /** Replaces the default light-blue hairline rule below the header with a
   * different color class. Use "ehs-rule-maroon" for emphasis or a custom
   * Tailwind class string (e.g. "h-0.5 bg-dark-blue") for an admin accent. */
  ruleClassName?: string;
};

export function BrandHeader({
  eyebrow,
  title,
  subtitle,
  right,
  logoHref,
  ruleClassName,
}: Props) {
  const logo = (
    <img
      src="/brand/ehs-horizontal.webp"
      alt="Episcopal High School"
      className="h-11 w-auto shrink-0"
    />
  );
  return (
    <header className="bg-white">
      <div className="mx-auto flex w-full max-w-5xl items-end justify-between gap-6 px-6 pt-6 pb-4">
        <div className="flex items-end gap-5 min-w-0">
          {logoHref ? (
            <Link href={logoHref} aria-label="Home" className="shrink-0">
              {logo}
            </Link>
          ) : (
            logo
          )}
          {(eyebrow || title || subtitle) && (
            <div className="hidden min-w-0 pb-1 sm:block">
              {eyebrow && (
                <div className="ehs-eyebrow truncate whitespace-nowrap">
                  {eyebrow}
                </div>
              )}
              {title && (
                <div className="mt-0.5 truncate text-base text-ink">
                  {title}
                </div>
              )}
              {subtitle && (
                <div className="mt-0.5 truncate text-xs italic text-cool-gray">
                  {subtitle}
                </div>
              )}
            </div>
          )}
        </div>
        {/* min-w-0 lets the slot compress when a wide nav would otherwise
            overflow into the logo column. The nav inside is responsible for
            its own flex-wrap behavior so items reflow onto multiple lines
            rather than truncate. */}
        {right && <div className="min-w-0 self-center">{right}</div>}
      </div>
      <hr className={ruleClassName ?? "ehs-rule"} />
    </header>
  );
}
