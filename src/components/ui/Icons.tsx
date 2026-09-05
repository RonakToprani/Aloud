interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
});

export const PlayIcon = ({ size = 22, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <path d="M8.4 5.6a1 1 0 0 1 1.53-.85l8.2 5.4a1.2 1.2 0 0 1 0 2l-8.2 5.4a1 1 0 0 1-1.53-.85z" />
  </svg>
);

export const PauseIcon = ({ size = 22, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <rect x="7" y="5" width="3.6" height="14" rx="1.5" />
    <rect x="13.4" y="5" width="3.6" height="14" rx="1.5" />
  </svg>
);

export const PreviousIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M18 6.5v11a.6.6 0 0 1-.94.5l-7.6-5.5a.6.6 0 0 1 0-1l7.6-5.5a.6.6 0 0 1 .94.5Z" fill="currentColor" stroke="none" />
    <path d="M6.4 5.6v12.8" />
  </svg>
);

export const NextIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M6 6.5v11a.6.6 0 0 0 .94.5l7.6-5.5a.6.6 0 0 0 0-1L6.94 6a.6.6 0 0 0-.94.5Z" fill="currentColor" stroke="none" />
    <path d="M17.6 5.6v12.8" />
  </svg>
);

export const TypeIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeWidth={1.5}>
    <path d="M3.2 18 8 6.2 12.8 18" />
    <path d="M5 14.2h6" />
    <path d="M14.6 18v-6.4a2.6 2.6 0 0 1 5.2 0V18" />
    <path d="M14.6 14.6h5.2" />
  </svg>
);

export const VoiceIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeWidth={1.8}>
    <path d="M4 10.5v3" />
    <path d="M8 7.5v9" />
    <path d="M12 5v14" />
    <path d="M16 8.5v7" />
    <path d="M20 10.5v3" />
  </svg>
);

export const ContentsIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4.5 6.5h15" />
    <path d="M4.5 12h15" />
    <path d="M4.5 17.5h9.5" />
  </svg>
);

export const BackIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </svg>
);

export const BookmarkIcon = ({ size = 20, className, filled }: IconProps & { filled?: boolean }) => (
  <svg {...base(size)} className={className} fill={filled ? "currentColor" : "none"}>
    <path d="M6.5 4.8h11a.7.7 0 0 1 .7.7v13.2a.5.5 0 0 1-.79.4L12 15.2l-5.41 3.9a.5.5 0 0 1-.79-.4V5.5a.7.7 0 0 1 .7-.7Z" />
  </svg>
);

export const SleepIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M19.2 14.4A7.6 7.6 0 0 1 9.3 4.6a7.7 7.7 0 1 0 9.9 9.8Z" />
  </svg>
);

export const CloseIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </svg>
);

export const PlusIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5.5v13M5.5 12h13" />
  </svg>
);

export const TrashIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4.8 7h14.4" />
    <path d="M9.4 7V5.6a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1V7" />
    <path d="M6.6 7l.8 11.2a1 1 0 0 0 1 .95h7.2a1 1 0 0 0 1-.95L17.4 7" />
  </svg>
);

export const CheckIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeWidth={2}>
    <path d="M5 12.5 9.5 17 19 7.5" />
  </svg>
);

/** The three-bar level meter used on the collapsed playback capsule. */
export const LevelIcon = ({ animated }: { animated?: boolean }) => (
  <span className="levelMeter" data-animated={animated ? "true" : "false"} aria-hidden="true">
    <span />
    <span />
    <span />
  </span>
);

export const AppleIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <path d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.8 3-.8s1.8.8 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.5-3.7ZM14.1 5.9c.6-.8 1.1-1.9.9-3-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.1-.5 2.8-1.3Z" />
  </svg>
);

export const GoogleIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <path d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.7h5.4c-.2 1.2-.9 2.3-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z" opacity=".95" />
    <path d="M12 21.6c2.7 0 4.9-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6c1.6 3.2 5 5.4 8.9 5.4Z" opacity=".8" />
    <path d="M6.4 13.6c-.2-.6-.3-1.2-.3-1.6s.1-1.1.3-1.6V7.8H3.1C2.4 9 2 10.5 2 12s.4 3 1.1 4.2l3.3-2.6Z" opacity=".65" />
    <path d="M12 6.3c1.5 0 2.8.5 3.8 1.5l2.8-2.8C16.9 3.4 14.7 2.4 12 2.4 8.1 2.4 4.7 4.6 3.1 7.8l3.3 2.6c.8-2.3 3-4.1 5.6-4.1Z" opacity=".5" />
  </svg>
);

/** iOS's share glyph: a box with an arrow leaving through the top. */
export const ShareIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeWidth={1.7}>
    <path d="M12 3.5v11" />
    <path d="M8.5 7 12 3.5 15.5 7" />
    <path d="M7 10.5H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5h-1" />
  </svg>
);

export const MoreIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <circle cx="12" cy="5.5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="18.5" r="1.7" />
  </svg>
);

export const AddSquareIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeWidth={1.7}>
    <rect x="4" y="4" width="16" height="16" rx="3.5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </svg>
);

export const MailIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeWidth={1.7}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
    <path d="m4.5 7 7.5 5.5L19.5 7" />
  </svg>
);

export const UserIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeWidth={1.7}>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M5 19.2c.9-3.3 3.6-4.9 7-4.9s6.1 1.6 7 4.9" />
  </svg>
);

export const CloudIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeWidth={1.7}>
    <path d="M7.5 18.5A4 4 0 0 1 7 10.6 5.5 5.5 0 0 1 17.6 9.4 3.9 3.9 0 0 1 17 18.5H7.5Z" />
    <path d="M12 11.5v6M9.5 14 12 11.5l2.5 2.5" />
  </svg>
);

export const SpeakerIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className} strokeWidth={1.7}>
    <path d="M4.5 9.5v5h3l4 3.2V6.3l-4 3.2h-3Z" />
    <path d="M15 9.2a4 4 0 0 1 0 5.6" />
    <path d="M17.6 6.6a7.5 7.5 0 0 1 0 10.8" />
  </svg>
);

export const StopIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
  </svg>
);
