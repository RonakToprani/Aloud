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
