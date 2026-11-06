import { useId } from "react";

/** 一笔圆相。still 为静置的墨圈，draw 为循环落笔，broken 为未成之圈。 */
export function Enso({ variant = "still", className }: { variant?: "still" | "draw" | "broken"; className?: string }) {
  const filterId = `brush-${useId().replace(/:/g, "")}`;
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true" focusable="false" data-variant={variant}>
      <defs>
        <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency=".06" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="5" />
        </filter>
      </defs>
      {variant === "draw" ? (
        <circle data-enso-draw cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" filter={`url(#${filterId})`} />
      ) : (
        <>
          <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" filter={`url(#${filterId})`}
            strokeDasharray={variant === "broken" ? "150 300" : "248 300"} transform="rotate(-70 50 50)" opacity=".9" />
          <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" filter={`url(#${filterId})`}
            strokeDasharray={variant === "broken" ? "60 300" : "180 300"} transform="rotate(-50 50 50)" opacity=".35" />
        </>
      )}
    </svg>
  );
}
