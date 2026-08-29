/**
 * PricePulse — Core App Router & Splash
 */
(function () {
  const splash = document.getElementById('splash');
  const app = document.getElementById('app');
  const views = {
    home: document.getElementById('view-home'),
    compare: document.getElementById('view-compare'),
    find: document.getElementById('view-find'),
    spend: document.getElementById('view-spend'),
  };

  let currentView = 'home';

  function initSplash() {
    setTimeout(() => {
      splash.classList.add('fade-out');
      app.classList.remove('hidden');
    }, 2400);
  }

  function navigateTo(route) {
    if (currentView === route) return;

    const fromView = views[currentView];
    const toView = views[route];

    fromView.classList.remove('view-active');
    fromView.classList.add('view-exit');

    app.classList.toggle('sub-view', route !== 'home');

    setTimeout(() => {
      fromView.classList.remove('view-exit');
      fromView.style.position = 'absolute';

      toView.style.position = 'relative';
      toView.classList.add('view-enter');
      toView.classList.remove('view-active');

      requestAnimationFrame(() => {
        toView.classList.add('view-active');
        toView.classList.remove('view-enter');
      });

      currentView = route;
    }, 300);
  }

  function navigateHome() {
    navigateTo('home');
  }

  function createRipple(e, element) {
    const ripple = element.querySelector('.ripple');
    if (!ripple) return;

    const rect = element.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    ripple.classList.remove('active');
    void ripple.offsetWidth;
    ripple.classList.add('active');
  }

  document.querySelectorAll('[data-route]').forEach(card => {
    card.addEventListener('click', (e) => {
      createRipple(e, card);
      const route = card.dataset.route;
      setTimeout(() => navigateTo(route), 200);
    });
  });

  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', navigateHome);
  });

  window.PricePulse = {
    navigateTo,
    navigateHome,
    getCurrentView: () => currentView,
  };

  initSplash();
})();
