import QuestionsStrip from './QuestionsStrip';
import ExtractionsCard from './ExtractionsCard';

// Silk's Questions pin — the pinned review queue at the top of the Brain graph view (per the
// original Brain spec). Holds BOTH the pending questions and the "new notes from our conversation"
// fact review, each as a clearly-labelled section with Brain's confidence-state colour language.
// Moved here out of the floating chat bubble, which now only shows a lightweight count badge.
export default function BrainQueue() {
  return (
    <section className="brain-queue" id="brain-queue" aria-label="Silk's questions and notes to review">
      <QuestionsStrip variant="brain" />
      <ExtractionsCard variant="brain" />
    </section>
  );
}
