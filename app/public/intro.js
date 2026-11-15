// Opening animation: sizes the spinning letter slot, reveals the login card as the intro
// rises into a header band, or flies the word into the top bar brand when logged in.
(() => {
  const intro = document.getElementById('intro');
  if (!intro) return;
  const root = document.documentElement;
  root.classList.add('intro-playing');
  const word = intro.querySelector('.intro-word');
  const swap = intro.querySelector('.intro-swap');
  const appView = document.getElementById('app-view');
  // In em so the slot keeps its proportions while the word shrinks
  const em = (el) => `${el.offsetWidth / parseFloat(getComputedStyle(word).fontSize)}em`;
  swap.style.setProperty('--w-a', em(intro.querySelector('.intro-a')));
  swap.style.setProperty('--w-ia', em(intro.querySelector('.intro-ia')));

  const settling = ['intro-settle', 'intro-settle-skip'];
  let leaving = false;
  const loggedIn = () => appView && !appView.hidden;

  // FLIP the word from where it is now onto the top bar brand, fading the white backdrop
  function flyToBrand() {
    if (intro.classList.contains('to-app')) return;
    root.classList.remove('intro-playing');
    root.classList.add('intro-to-brand');
    const brand = document.querySelector('.topbar .brand');
    const from = word.getBoundingClientRect();
    const { height, backgroundColor, borderBottomColor } = getComputedStyle(intro);
    intro.style.height = height;
    intro.classList.add('to-app');
    const base = word.getBoundingClientRect();
    const to = brand.getBoundingClientRect();
    const timing = { duration: 800, easing: 'cubic-bezier(.7, 0, .3, 1)', fill: 'forwards' };
    const done = () => { root.classList.remove('intro-to-brand'); intro.remove(); };

    // No brand to land on (hidden on small phones): just fade away
    if (!to.width) {
      intro.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, duration: 400 }).finished.then(done);
      return;
    }
    const place = (r) => `translate(${r.left - base.left}px, ${r.top - base.top}px) scale(${r.width / base.width})`;
    word.animate([{ transform: place(from) }, { transform: place(to) }], timing).finished.then(done);
    intro.animate([
      { backgroundColor, borderBottomColor },
      { backgroundColor: 'transparent', borderBottomColor: 'transparent' },
    ], timing);
  }

  intro.addEventListener('animationstart', (e) => {
    if (e.target !== intro || !settling.includes(e.animationName)) return;
    leaving = true;
    if (loggedIn()) flyToBrand();
    else root.classList.remove('intro-playing');
  });
  intro.addEventListener('animationend', (e) => {
    if (e.target === intro && settling.includes(e.animationName)) intro.classList.add('settled');
  });
  intro.addEventListener('click', () => intro.classList.add('done'));

  // Logging in after the intro reached the login page: move it into the top bar
  if (appView) {
    new MutationObserver(() => { if (leaving && loggedIn()) flyToBrand(); })
      .observe(appView, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
