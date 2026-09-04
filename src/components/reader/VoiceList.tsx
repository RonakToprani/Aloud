"use client";

import { useMemo, useState } from "react";
import { CheckIcon } from "@/components/ui/Icons";
import { groupVoices } from "@/lib/hooks/useSpeechEngine";
import type { EngineVoice, VoiceTier } from "@/lib/speech/engine";
import styles from "./Sheets.module.css";

interface Props {
  voices: EngineVoice[];
  preferredLang: string;
  voiceId: string | null;
  onVoice: (voiceId: string) => void;
  ready: boolean;
}

/** Provider metadata worth surfacing. A voice Microsoft built for narrating
 *  novels is the one to pick in a reading app, so it says so; everything else
 *  says nothing rather than inventing a label. */
const NARRATION_TRAITS = new Set(["novel", "audiobook", "narration"]);

function traitLabel(voice: EngineVoice): string | null {
  const traits = voice.traits ?? [];
  if (traits.some((t) => NARRATION_TRAITS.has(t.toLowerCase()))) return "Recommended";
  return null;
}

/** Only tiers worth calling out; "standard" needs no badge. */
const TIER_LABEL: Partial<Record<VoiceTier, string>> = {
  premium: "Premium",
  enhanced: "Enhanced",
  compact: "Compact",
  siri: "Unavailable",
  novelty: "Novelty",
};

const isApple = () =>
  typeof navigator !== "undefined" && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);

export function VoiceList({ voices, preferredLang, voiceId, onVoice, ready }: Props) {
  const [showAll, setShowAll] = useState(false);

  const groups = useMemo(
    () => groupVoices(voices, preferredLang, showAll),
    [voices, preferredLang, showAll],
  );
  const hiddenCount = useMemo(
    () => voices.length - groupVoices(voices, preferredLang, false).reduce((n, g) => n + g.voices.length, 0),
    [voices, preferredLang],
  );

  // A badge on every row carries no information. Badges mark the exception:
  // a tier is only worth labelling when it is a minority of what is on screen.
  // With sixty cloud voices listed, "Enhanced" is the norm and says nothing;
  // the two compact device voices among them are what a reader wants flagged.
  const visible = groups.flatMap((group) => group.voices);
  const tierCounts = visible.reduce<Record<string, number>>((counts, voice) => {
    counts[voice.tier] = (counts[voice.tier] ?? 0) + 1;
    return counts;
  }, {});
  /** Warnings always show; quality tiers only when they set a voice apart. */
  const ALWAYS: VoiceTier[] = ["siri", "novelty"];
  const distinguishes = (tier: VoiceTier) => {
    if (!TIER_LABEL[tier]) return false;
    if (ALWAYS.includes(tier)) return true;
    return (tierCounts[tier] ?? 0) <= visible.length / 2;
  };

  // "Recommended" earns its place only while it still singles voices out.
  const recommendedCount = visible.filter((voice) => traitLabel(voice)).length;
  const showTrait = recommendedCount > 0 && recommendedCount <= visible.length / 2;

  const best = groups[0]?.voices[0];
  const noGoodVoices = ready && voices.length > 0 && (!best || best.quality < 0.5);

  if (!ready) return <p className={styles.hint}>Looking for voices on this device…</p>;

  if (!voices.length) {
    return (
      <p className={styles.hint}>
        This device reports no speech voices at all. On iPhone and iPad they appear once a voice has
        been downloaded in Settings › Accessibility › Spoken Content › Voices.
      </p>
    );
  }

  return (
    <>
      {/* The single most common disappointment: a phone full of compact and
          Eloquence voices, and a downloaded Siri voice that never appears. */}
      {isApple() && (noGoodVoices || showAll) && (
        <p className={styles.hint}>
          For a much better voice, open <strong>Settings › Accessibility › Spoken Content ›
          Voices › English</strong> and download one marked <strong>Premium</strong> or{" "}
          <strong>Enhanced</strong>. It will appear here straight away. Siri&rsquo;s own voices are
          reserved by the system and can&rsquo;t be used by any app or website.
        </p>
      )}

      <div className={styles.voiceList}>
        {groups.map((group) => (
          <div key={group.lang} className={styles.voiceGroup}>
            <div className={styles.voiceGroupLabel}>{group.label}</div>
            {group.voices.map((voice) => (
              <button
                key={voice.id}
                type="button"
                role="radio"
                aria-checked={voice.id === voiceId}
                className={styles.voiceRow}
                data-active={voice.id === voiceId ? "true" : undefined}
                onClick={() => onVoice(voice.id)}
              >
                <span className={styles.voiceName}>{voice.name}</span>
                <span className={styles.voiceMeta}>
                  {showTrait && traitLabel(voice) && (
                    <span className={styles.badge} data-tier="premium">
                      {traitLabel(voice)}
                    </span>
                  )}
                  {distinguishes(voice.tier) && (
                    <span className={styles.badge} data-tier={voice.tier}>
                      {TIER_LABEL[voice.tier]}
                    </span>
                  )}
                  {voice.id === voiceId && <CheckIcon size={16} />}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>

      {hiddenCount > 0 && (
        <button type="button" className={styles.moreVoices} onClick={() => setShowAll((v) => !v)}>
          {showAll
            ? "Show fewer voices"
            : `Show all ${voices.length} voices, including other languages`}
        </button>
      )}
    </>
  );
}
