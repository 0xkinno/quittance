'use client';

/**
 * Motion primitives.
 *
 * The design brief permits four kinds of motion and forbids everything else by
 * name, so this file exists to make the permitted set easy and the forbidden
 * set inconvenient.
 *
 * **Permitted**
 *   1. The in-flight breathing pulse.
 *   2. The resolution transition — glow out, mark in.
 *   3. One orchestrated reveal where a section's meaning depends on sequence.
 *   4. Response to direct user action: press, hover, scroll-linked progress.
 *
 * **Forbidden, and deliberately not implemented here**
 *   fade-and-slide-up on every section, parallax, particle fields, scattered
 *   scroll reveals. The brief's reasoning is that they read as generated, and
 *   it is right: twenty scattered reveals are noise, one orchestrated moment
 *   is a point being made.
 *
 * `Reveal` is therefore a *section-level* primitive used sparingly, not a
 * wrapper to put around every element.
 */

import {
  motion,
  useInView,
  useReducedMotion,
  useScroll,
  useSpring,
  type Variants,
} from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A single orchestrated entrance for one section.
 *
 * Children stagger against each other so the section reads in order — this is
 * the "one orchestrated moment" the brief allows, and it is used on the
 * sections where sequence carries meaning, not on all of them.
 */

/**
 * A motion component typed to accept ordinary React children.
 *
 * React 19's types made `ReactPortal.children` required, which makes a plain
 * `ReactNode` unassignable to framer-motion 11's `children` union. The
 * disagreement is purely in the type declarations — every value passed here is
 * a normal node and the runtime is unaffected — so the cast is narrowed to
 * exactly the props these two components use rather than widened to `any`.
 */
type MotionLike = React.ComponentType<{
  readonly children?: ReactNode;
  readonly className?: string | undefined;
  readonly ref?: React.Ref<HTMLDivElement>;
  readonly initial?: unknown;
  readonly animate?: unknown;
  readonly variants?: Variants;
  readonly whileHover?: unknown;
  readonly whileTap?: unknown;
  readonly transition?: unknown;
}>;

export function Reveal({
  children,
  className,
  delay = 0,
  as = 'div',
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly delay?: number;
  readonly as?: 'div' | 'section' | 'li';
}): React.JSX.Element {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0 });
  const [forced, setForced] = useState(false);
  const Component = motion[as] as unknown as MotionLike;

  /*
   * The failsafe, and the reason this component is written with explicit
   * state rather than `whileInView`.
   *
   * An earlier version faded in purely on an IntersectionObserver. Whole
   * sections stayed at opacity 0 — during a full-page capture the viewport
   * becomes the document height and the observer never reports an
   * intersection, and a reader on an unusual viewport can hit the same thing.
   * A blank band is the worst failure this page has, because nothing on
   * screen suggests anything is missing.
   *
   * So the reveal is an enhancement with a deadline: if the observer has not
   * fired within 900ms of mount, the content shows anyway. Motion is allowed
   * to be missed; content is not.
   */
  useEffect(() => {
    const timer = setTimeout(() => setForced(true), 900);
    return () => clearTimeout(timer);
  }, []);

  const shown = inView || forced || reduced;

  const variants: Variants = {
    hidden: { opacity: 0, y: reduced ? 0 : 14 },
    shown: {
      opacity: 1,
      y: 0,
      transition: {
        duration: reduced ? 0 : 0.5,
        ease: [0.16, 1, 0.3, 1],
        delay: reduced ? 0 : delay,
        staggerChildren: reduced ? 0 : 0.06,
      },
    },
  };

  return (
    <Component
      ref={ref}
      className={className}
      initial="hidden"
      animate={shown ? 'shown' : 'hidden'}
      variants={variants}
    >
      {children}
    </Component>
  );
}

export const revealChild: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } },
};

/**
 * A surface that answers the pointer.
 *
 * It lifts and its hairline sharpens. It does **not** take the signal blue:
 * that colour means one thing in this product — money currently in flight —
 * and spending it on hover states would make the one element that matters
 * indistinguishable from decoration.
 *
 * This is the whole argument for restraint stated as code: the page still
 * feels alive under the cursor, and the single glow keeps its meaning.
 */
export function Surface({
  children,
  className,
  as = 'div',
  interactive = true,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly as?: 'div' | 'article' | 'li' | 'a';
  readonly interactive?: boolean;
}): React.JSX.Element {
  const reduced = useReducedMotion();
  const Component = motion[as] as unknown as MotionLike;

  return (
    <Component
      className={className}
      whileHover={
        interactive && !reduced
          ? { y: -3, boxShadow: 'var(--lift-strong)', borderColor: 'var(--ink-faint)' }
          : undefined
      }
      whileTap={interactive && !reduced ? { y: -1 } : undefined}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </Component>
  );
}

/**
 * A hairline that tracks reading progress across the top of the page.
 *
 * This is motion in direct response to a user action — scrolling — which the
 * brief permits. It is a rule on paper rather than a coloured bar, so it
 * belongs to the ledger rather than to a dashboard.
 */
export function ScrollRule(): React.JSX.Element {
  const { scrollYProgress } = useScroll();
  const reduced = useReducedMotion();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 220,
    damping: 40,
    restDelta: 0.001,
  });

  return (
    <motion.div
      aria-hidden
      style={{
        scaleX: reduced ? 1 : scaleX,
        position: 'fixed',
        insetInline: 0,
        top: 0,
        height: 2,
        background: 'var(--ink)',
        transformOrigin: '0 50%',
        zIndex: 60,
      }}
    />
  );
}
