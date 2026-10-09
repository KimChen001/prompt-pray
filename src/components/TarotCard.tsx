"use client";
import { useState, type CSSProperties } from "react";
import { CARD_BACK, cardImage, cardNumeral, getCard } from "@/lib/tarot/deck";
import { useI18n } from "@/lib/i18n";

interface Props {
  /** Omit for a face-down card whose identity is not yet decided. */
  id?: string;
  reversed?: boolean;
  revealed?: boolean;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  picked?: boolean;
  style?: CSSProperties;
  className?: string;
}

export function TarotCard({ id, reversed = false, revealed = false, label, onClick, disabled, picked, style, className }: Props) {
  const { pick } = useI18n();
  const [broken, setBroken] = useState(false);
  const card = id ? getCard(id) : null;

  return (
    <button
      type="button"
      className={`tcard ${className ?? ""}`}
      data-revealed={revealed && !!card}
      data-reversed={reversed}
      data-picked={picked}
      onClick={onClick}
      disabled={disabled || !onClick}
      aria-label={label}
      style={style}
    >
      <span className="tcard-inner">
        <span className="tcard-face tcard-back">
          <img src={CARD_BACK} alt="" draggable={false} />
        </span>
        {card && (
          <span className="tcard-face tcard-front" data-broken={broken}>
            {revealed && <img src={cardImage(card.id)} alt="" draggable={false} onError={() => setBroken(true)} />}
            {/* Text face if the image fails to load — never a broken-image icon */}
            <span className="tcard-fallback" aria-hidden="true">
              <span className="meta">{cardNumeral(card)}</span>
              {pick(card.name)}
            </span>
          </span>
        )}
      </span>
    </button>
  );
}
