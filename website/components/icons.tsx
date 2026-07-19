export function Check() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" opacity=".22" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}

export function GitHubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function DiscordIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M20.32 5.37a18.6 18.6 0 0 0-4.6-1.43.07.07 0 0 0-.08.04c-.2.36-.42.82-.57 1.19a17.2 17.2 0 0 0-5.15 0 8.4 8.4 0 0 0-.58-1.19.08.08 0 0 0-.08-.04c-1.6.28-3.14.76-4.6 1.43a.07.07 0 0 0-.03.03C1.4 9.4.68 13.3 1.03 17.15a.08.08 0 0 0 .03.05 18.7 18.7 0 0 0 5.63 2.85.08.08 0 0 0 .08-.03c.43-.6.82-1.23 1.16-1.9a.07.07 0 0 0-.04-.1 12.3 12.3 0 0 1-1.76-.84.07.07 0 0 1-.01-.12l.35-.27a.08.08 0 0 1 .08-.01c3.7 1.69 7.7 1.69 11.36 0a.08.08 0 0 1 .08.01l.35.27a.07.07 0 0 1-.01.12c-.56.33-1.15.6-1.76.84a.07.07 0 0 0-.04.1c.35.67.74 1.3 1.16 1.9a.08.08 0 0 0 .08.03 18.6 18.6 0 0 0 5.64-2.85.07.07 0 0 0 .03-.05c.42-4.45-.7-8.32-2.96-11.75a.06.06 0 0 0-.03-.03ZM8.68 14.8c-1.1 0-2-1.03-2-2.28 0-1.26.88-2.28 2-2.28 1.13 0 2.02 1.03 2 2.28 0 1.25-.88 2.28-2 2.28Zm6.65 0c-1.1 0-2-1.03-2-2.28 0-1.26.88-2.28 2-2.28 1.13 0 2.02 1.03 2 2.28 0 1.25-.87 2.28-2 2.28Z" />
    </svg>
  );
}

export function LogoMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="8" x="2" y="2" rx="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </svg>
  );
}

export function RocketIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

export function WrenchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/** v2.0.1:世界地圖亮點用。 */
export function MapIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18 3.5 20.5A1 1 0 0 1 2 19.6V5.4a1 1 0 0 1 .6-.92L9 2m0 16 6 2m-6-2V2m6 18 5.4-2.5a1 1 0 0 0 .6-.92V2.4a1 1 0 0 0-1.4-.92L15 4m0 16V2m0 2 6-2" />
      <circle cx="12" cy="10" r="2" />
    </svg>
  );
}

/** v2.0.1:主題系統亮點用。 */
export function PaletteIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22a1 1 0 0 1 0-10 5 5 0 0 0 0-10 10 10 0 1 0 10 10 1 1 0 0 0-1-1h-3a1 1 0 0 1-1-1 1 1 0 0 1 .3-.7 2.5 2.5 0 1 0-3.6 0 1 1 0 0 1 .3.7 1 1 0 0 1-1 1" />
    </svg>
  );
}

/** v2.0.1:贊助者先行版亮點用。 */
export function SponsorIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12 2 2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.8z" />
    </svg>
  );
}
