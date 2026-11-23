(() => {
  const { gsap, ScrollTrigger } = window;
  const headings = document.querySelectorAll('[data-word-reveal]');
  if (!gsap || !ScrollTrigger || !headings.length) return;

  function splitWords(heading) {
    const original = [...heading.childNodes];
    const originalLabel = heading.getAttribute('aria-label');
    const label = originalLabel ?? heading.innerText.trim().replace(/\s+/g, ' ');
    const content = document.createDocumentFragment();
    content.append(...original.map((node) => node.cloneNode(true)));

    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const words = [];
    for (const text of textNodes) {
      const pieces = document.createDocumentFragment();
      for (const part of text.data.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          pieces.append(part);
        } else {
          const word = document.createElement('span');
          word.className = 'heading-word';
          word.setAttribute('aria-hidden', 'true');
          word.textContent = part;
          pieces.append(word);
          words.push(word);
        }
      }
      text.replaceWith(pieces);
    }

    heading.replaceChildren(content);
    heading.setAttribute('aria-label', label);
    return {
      words,
      restore() {
        heading.replaceChildren(...original);
        if (originalLabel === null) heading.removeAttribute('aria-label');
        else heading.setAttribute('aria-label', originalLabel);
      },
    };
  }

  gsap.registerPlugin(ScrollTrigger);
  const media = gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)', () => {
    const splits = [];
    for (const heading of headings) {
      const split = splitWords(heading);
      splits.push(split);
      if (!split.words.length) continue;
      gsap.fromTo(split.words, { opacity: 0, yPercent: 42 }, {
        opacity: 1,
        yPercent: 0,
        duration: 0.5,
        stagger: 0.09,
        ease: 'power3.out',
        clearProps: 'opacity,transform',
        scrollTrigger: {
          trigger: heading,
          start: 'top 87%',
          once: true,
        },
      });
    }
    return () => splits.forEach((split) => split.restore());
  });

  document.fonts?.ready.then(() => ScrollTrigger.refresh());
})();
