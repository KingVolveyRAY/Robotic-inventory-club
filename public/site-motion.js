(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let motion;

  function startCards({ animate, inView, hover, motionValue }, signal) {
    const cards = [...document.querySelectorAll('[data-reveal]')];
    if (!cards.length) return;

    const entrance = new Map();
    const hoverStates = new Map();
    const spring = { type: 'spring', stiffness: 380, damping: 28 };

    // Leave cards already on screen visible when the scripts finish loading.
    const offscreenCards = cards.filter((card) => {
      const { top, bottom } = card.getBoundingClientRect();
      return top >= window.innerHeight || bottom <= 0;
    });
    const stopEntrance = 'IntersectionObserver' in window && inView(offscreenCards, (card) => {
      if (signal.aborted || card.matches(':focus-within')) return;
      entrance.set(card, animate(card, {
        opacity: [0, 1],
        transform: ['translateY(18px)', 'none'],
      }, { duration: 0.44, ease: [0.22, 0.8, 0.24, 1] }));
    }, { margin: '0px 0px 12px' });

    const stopHover = hover('.equipment-card', (card) => {
      let state = hoverStates.get(card);
      if (!state) {
        const image = card.querySelector('.card-media img');
        const progress = motionValue(0);
        const unsubscribe = progress.on('change', (value) => {
          // The individual translate property composes with the entrance transform.
          card.style.translate = `0px ${-5 * value}px`;
          if (image) image.style.transform = `scale(${1 + 0.045 * value})`;
        });
        state = { progress, image, unsubscribe };
        hoverStates.set(card, state);
      }
      animate(state.progress, 1, spring);
      return () => animate(state.progress, 0, spring);
    });

    signal.addEventListener('abort', () => {
      if (stopEntrance) stopEntrance();
      stopHover();
      for (const [card, animation] of entrance) {
        animation.stop();
        card.style.removeProperty('opacity');
        card.style.removeProperty('transform');
      }
      for (const [card, { progress, image, unsubscribe }] of hoverStates) {
        unsubscribe();
        progress.stop();
        card.style.removeProperty('translate');
        image?.style.removeProperty('transform');
      }
    }, { once: true });
  }

  function startScroll(Lenis, signal) {
    const lenis = new Lenis({ autoRaf: true, allowNestedScroll: true, stopInertiaOnNavigate: true });
    const update = window.ScrollTrigger?.update;
    if (update) lenis.on('scroll', update);

    for (const link of document.querySelectorAll('a[data-smooth-scroll]')) {
      link.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = document.getElementById(link.hash.slice(1));
        if (!target) return;

        event.preventDefault();
        if (window.location.hash !== link.hash) history.pushState(null, '', link.hash);
        target.focus({ preventScroll: true });
        lenis.scrollTo(target, { duration: 0.75 });
      }, { signal });
    }
    signal.addEventListener('abort', () => lenis.destroy(), { once: true });
  }

  function syncMotion() {
    motion?.abort();
    if (reducedMotion.matches) return;

    motion = new AbortController();
    if (window.Motion) startCards(window.Motion, motion.signal);
    if (window.Lenis) startScroll(window.Lenis, motion.signal);
  }

  reducedMotion.addEventListener('change', syncMotion);
  syncMotion();
})();
