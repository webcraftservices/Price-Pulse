/**
 * PricePulse — AI Find Products Module
 */
(function () {
  const uploadZone = document.getElementById('upload-zone');
  const imageInput = document.getElementById('image-input');
  const uploadPlaceholder = document.getElementById('upload-placeholder');
  const uploadPreview = document.getElementById('upload-preview');
  const previewImg = document.getElementById('preview-img');
  const clearUpload = document.getElementById('clear-upload');
  const searchBtn = document.getElementById('search-btn');
  const findLoading = document.getElementById('find-loading');
  const findStatus = document.getElementById('find-status');
  const findResults = document.getElementById('find-results');
  const orbCaption = document.getElementById('orb-caption');
  const orbAiLabel = document.getElementById('orb-ai-label');
  const orbCheck = document.getElementById('orb-check');
  const takePhotoBtn = document.getElementById('take-photo-btn');
  const uploadImageBtn = document.getElementById('upload-image-btn');
  const viewFind = document.getElementById('view-find');
  const orbCluster = document.getElementById('find-orb-cluster');
  const describeInput = document.getElementById('describe-input');
  const describeSubmit = document.getElementById('describe-submit');
  const suggestionChips = document.querySelectorAll('.suggestion-chip');

  let currentImage = null;
  let currentImageData = null;
  let lastQuery = '';
  let statusInterval = null;

  // ----- Orb videos: three pre-rendered states (idle/searching/result), all
  // autoplay+loop from page load, kept in perfect sync position via CSS.
  // JS only ever toggles which one is .active — the crossfade, position and
  // looping are entirely CSS/video, per spec (#9: no JS animation on the orb). -----
  const orbVideoIdle = document.getElementById('orb-video-idle');
  const orbVideoSearching = document.getElementById('orb-video-searching');
  const orbVideoResult = document.getElementById('orb-video-result');
  const orbVideos = [orbVideoIdle, orbVideoSearching, orbVideoResult];

  function setActiveOrbVideo(name) {
    const map = { idle: orbVideoIdle, searching: orbVideoSearching, result: orbVideoResult };
    orbVideos.forEach((v) => v && v.classList.toggle('active', v === map[name]));
  }

  const IMAGE_STATUS_MESSAGES = [
    'Ready to help…',
    'Analyzing image…',
    'Extracting details…',
    'Identifying product…',
    'Searching stores…',
    'Matching product…',
    'Preparing results…',
    'Done',
  ];

  const TEXT_STATUS_MESSAGES = [
    'Searching stores…',
    'Matching product…',
    'Preparing results…',
    'Done',
  ];

  function formatPrice(amount) {
    if (!amount) return 'See price on site';
    return '₹' + amount.toLocaleString('en-IN');
  }

  // Cycles the status line + orb caption through a message list, one at a time,
  // fading between them. Clamps on the last message if the real request outlasts
  // the list. Purely cosmetic — does not affect when the actual API call resolves.
  function startStatusCycle(messages) {
    stopStatusCycle();
    let i = 0;
    const setMessage = (text) => {
      [findStatus, orbCaption].forEach((el) => {
        if (!el) return;
        el.classList.add('msg-fade-out');
        setTimeout(() => {
          el.textContent = text;
          el.classList.remove('msg-fade-out');
        }, 180);
      });
    };
    setMessage(messages[0]);
    statusInterval = setInterval(() => {
      i = Math.min(i + 1, messages.length - 1);
      setMessage(messages[i]);
    }, 1000);
  }

  function stopStatusCycle() {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
  }

  // ----- State transitions -----

  function enterSearchingState() {
    viewFind.classList.add('is-scanning');
    viewFind.classList.add('is-searching');
    orbAiLabel.classList.add('hidden');
    orbCheck.classList.remove('visible');
    setActiveOrbVideo('searching');
    clearUpload.disabled = true; // lock "remove photo" while the image is under scan
    // Let the fade-out transition finish before collapsing the layout space —
    // avoids the abrupt jump the spec explicitly calls out against.
    clearTimeout(enterSearchingState._collapseTimer);
    enterSearchingState._collapseTimer = setTimeout(() => {
      viewFind.classList.add('is-searching-collapsed');
    }, 420);
  }

  function exitSearchingState() {
    viewFind.classList.remove('is-scanning');
    stopStatusCycle();
  }

  function enterFoundState() {
    viewFind.classList.add('is-found');
    orbCaption.classList.add('msg-fade-out');
    setActiveOrbVideo('result');
    setTimeout(() => {
      orbCaption.textContent = 'Done';
      orbCaption.classList.remove('msg-fade-out');
    }, 180);
    orbCheck.classList.add('visible');
    clearUpload.disabled = false; // unlock "remove photo" now that the product was found
  }

  // Clears any leftover "found"/scanning visuals from a previous search, without
  // touching the image or describe-bar fields. Used right before a brand new
  // search begins (new photo, retake, or new text query) so stale result state
  // never lingers into the next run. Synchronous — the caller's own state-enter
  // (enterSearchingState) immediately follows and drives its own smooth CSS
  // transitions, so no extra fade timing is needed here.
  function clearPriorResults() {
    stopStatusCycle();
    clearTimeout(enterSearchingState._collapseTimer);
    viewFind.classList.remove('is-found', 'is-scanning', 'is-searching', 'is-searching-collapsed');
    findResults.classList.add('hidden');
    findResults.innerHTML = '';
    findResults.style.opacity = '';
    findResults.style.transition = '';
    findLoading.classList.add('hidden');
    orbAiLabel.classList.remove('hidden');
    orbCheck.classList.remove('visible');
    setActiveOrbVideo('idle');
    clearUpload.disabled = false;
  }

  // Full reset back to the initial AI Find screen — product, comparison data,
  // scanning state and processing messages are all cleared, and the orb /
  // Take Photo / Upload Image / search bar / Try Searching are restored.
  // Fades out whatever is currently on screen (result card, uploaded preview)
  // before swapping everything back to the first-load layout, rather than
  // popping instantly.
  const RESET_FADE_MS = 280;

  function resetToState1(opts) {
    const fade = !opts || opts.fade !== false;
    stopStatusCycle();
    clearTimeout(enterSearchingState._collapseTimer);

    // Fade the caption back to its idle text right away — cheap and always
    // smoother than a hard swap, independent of the rest of the fade timing.
    orbCaption.classList.add('msg-fade-out');
    setTimeout(() => {
      orbCaption.textContent = 'Ready to help…';
      orbCaption.classList.remove('msg-fade-out');
    }, 180);

    const hasResults = !findResults.classList.contains('hidden') || viewFind.classList.contains('is-found');
    const hasPreview = !uploadPreview.classList.contains('hidden');
    const isMidSearch = viewFind.classList.contains('is-scanning') || viewFind.classList.contains('is-searching');
    const needsFade = fade && (hasResults || hasPreview || isMidSearch);

    function finalize() {
      // --- product / comparison data / processing state, gone ---
      currentImage = null;
      currentImageData = null;
      lastQuery = '';
      imageInput.value = '';
      previewImg.src = '';
      describeInput.value = '';

      findResults.classList.add('hidden');
      findResults.innerHTML = '';
      findResults.style.opacity = '';
      findResults.style.transition = '';
      findLoading.classList.add('hidden');

      // --- restore the initial upload area ---
      uploadPlaceholder.classList.remove('hidden');
      uploadPreview.classList.add('hidden');
      uploadPreview.style.opacity = '';
      uploadPreview.style.transition = '';
      searchBtn.classList.add('hidden');
      searchBtn.disabled = false;
      clearUpload.disabled = false;

      // --- orb back to idle ---
      orbAiLabel.classList.remove('hidden');
      orbCheck.classList.remove('visible');
      setActiveOrbVideo('idle');

      // --- drop scanning/found state; if Take Photo/Upload/search bar/Try
      // Searching were collapsed out of flow, un-collapse them one frame after
      // clearing display:none so the existing opacity/transform transition
      // fades+slides them back in instead of popping in instantly ---
      const wasCollapsed = viewFind.classList.contains('is-searching-collapsed');
      viewFind.classList.remove('is-scanning', 'is-found', 'is-searching-collapsed');
      if (wasCollapsed) {
        requestAnimationFrame(() => viewFind.classList.remove('is-searching'));
      } else {
        viewFind.classList.remove('is-searching');
      }
    }

    if (needsFade) {
      if (hasResults) {
        findResults.style.transition = `opacity ${RESET_FADE_MS}ms ease`;
        findResults.style.opacity = '0';
      }
      if (hasPreview) {
        uploadPreview.style.transition = `opacity ${RESET_FADE_MS}ms ease`;
        uploadPreview.style.opacity = '0';
      }
      setTimeout(finalize, RESET_FADE_MS);
    } else {
      finalize();
    }
  }

  // ----- Image upload flow -----

  function showPreview(dataUrl) {
    currentImageData = dataUrl;
    previewImg.src = dataUrl;
    uploadPlaceholder.classList.add('hidden');
    uploadPreview.classList.remove('hidden');
    searchBtn.classList.remove('hidden');
    findResults.classList.add('hidden');
  }

  function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) return;

    // A completely new search is starting — drop any leftover product /
    // comparison / scanning state from a previous run before showing this image.
    clearPriorResults();

    currentImage = file;

    const reader = new FileReader();
    reader.onload = (e) => showPreview(e.target.result);
    reader.readAsDataURL(file);
  }

  uploadZone.addEventListener('click', () => {
    imageInput.removeAttribute('capture');
    imageInput.click();
  });

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
  });

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    handleFile(e.dataTransfer.files[0]);
  });

  // "Take Photo" opens a live in-page camera (getUserMedia) so the user can frame
  // and capture a shot without ever leaving the app. "Upload Image" keeps opening
  // the plain file/gallery picker exactly as before. Both ultimately feed the same
  // existing handleFile() pipeline — no new upload/search logic.
  if (takePhotoBtn) {
    takePhotoBtn.addEventListener('click', () => {
      openCamera();
    });
  }
  if (uploadImageBtn) {
    uploadImageBtn.addEventListener('click', () => {
      imageInput.removeAttribute('capture');
      imageInput.click();
    });
  }

  // ----- Native camera capture (Take Photo) -----
  // Overlay has two states: "live" (viewfinder + shutter) and "preview" (captured
  // shot + Find / Click Again). The captured photo is only handed to handleFile()
  // — i.e. only actually used for the AI search — when the user taps "Find".

  let cameraStream = null;
  let cameraEls = null; // lazily-built overlay elements, reused across opens
  let cameraFacing = 'environment';
  let capturedBlob = null;

  function buildCameraOverlay() {
    if (cameraEls) return cameraEls;

    if (!document.getElementById('camera-capture-styles')) {
      const style = document.createElement('style');
      style.id = 'camera-capture-styles';
      style.textContent = `
        .camera-overlay {
          position: fixed; inset: 0; z-index: 999;
          background: rgba(8, 8, 10, 0.96);
          display: flex; align-items: center; justify-content: center;
          opacity: 0; pointer-events: none;
          transition: opacity 0.2s ease;
        }
        .camera-overlay.active { opacity: 1; pointer-events: auto; }
        .camera-overlay__panel {
          position: relative; width: 100%; height: 100%; max-width: 480px;
          max-height: 100vh;
          margin: 0 auto;
          background: var(--surface, #111114);
          display: flex; flex-direction: column;
          overflow: hidden;
        }
        .camera-overlay__topbar {
          display: flex; align-items: center; gap: var(--space-3, 12px);
          padding: var(--space-4, 16px);
          flex: 0 0 auto;
        }
        .camera-overlay__title {
          font-family: var(--font-primary, sans-serif);
          font-size: var(--text-body, 0.9375rem);
          font-weight: var(--weight-semibold, 600);
          color: var(--text-primary, #f5f5f7);
        }
        .camera-overlay__stage {
          position: relative; flex: 1 1 auto; min-height: 0;
          background: #000; overflow: hidden;
        }
        .camera-overlay__video, .camera-overlay__canvas, .camera-overlay__preview-img {
          position: absolute; inset: 0;
          width: 100%; height: 100%; object-fit: cover; display: block;
        }
        .camera-overlay__canvas, .camera-overlay__preview-img { display: none; }
        .camera-overlay__hint {
          position: absolute; top: 0; left: 0; right: 0;
          padding: var(--space-3, 12px) var(--space-4, 16px);
          font-family: var(--font-primary, sans-serif);
          font-size: var(--text-caption, 0.8rem);
          color: var(--text-primary, #f5f5f7);
          background: linear-gradient(to bottom, rgba(0,0,0,0.55), transparent);
          text-align: center; pointer-events: none;
        }
        .camera-overlay__error {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          padding: var(--space-6, 24px); text-align: center;
          font-family: var(--font-primary, sans-serif);
          color: var(--text-secondary, #a8a8b3);
          font-size: var(--text-body, 0.9375rem);
        }
        .camera-overlay__controls {
          flex: 0 0 auto;
          display: flex; align-items: center; justify-content: center;
          gap: var(--space-3, 12px);
          padding: var(--space-5, 20px) var(--space-4, 16px);
        }
        .camera-overlay__live-controls {
          display: flex; align-items: center; justify-content: space-between;
          width: 100%;
        }
        .camera-overlay__preview-controls {
          display: none;
          flex-direction: column;
          width: 100%; gap: var(--space-3, 12px);
        }
        .camera-overlay.is-preview .camera-overlay__live-controls { display: none; }
        .camera-overlay.is-preview .camera-overlay__preview-controls { display: flex; }
        .camera-overlay.is-preview .camera-overlay__video { display: none; }
        .camera-overlay.is-preview .camera-overlay__preview-img { display: block; }
        .camera-overlay__btn {
          display: flex; align-items: center; justify-content: center;
          width: 44px; height: 44px; border-radius: 999px;
          background: var(--glass-surface-strong, rgba(255,255,255,0.07));
          border: 1px solid var(--border, rgba(255,255,255,0.08));
          color: var(--text-primary, #f5f5f7);
          cursor: pointer; flex-shrink: 0;
        }
        .camera-overlay__btn svg { width: 20px; height: 20px; }
        .camera-overlay__shutter {
          width: 66px; height: 66px; border-radius: 999px;
          background: var(--text-on-accent, #fff);
          border: 4px solid var(--primary, #6e56cf);
          cursor: pointer; flex-shrink: 0;
        }
        .camera-overlay__shutter:active { transform: scale(0.94); }
        .camera-overlay__spacer { width: 44px; height: 44px; flex-shrink: 0; }
        .camera-overlay__find-btn, .camera-overlay__retake-btn {
          width: 100%; border: none; border-radius: 999px;
          padding: var(--space-3, 12px) var(--space-4, 16px);
          font-family: var(--font-primary, sans-serif);
          font-size: var(--text-button, 0.9rem);
          font-weight: var(--weight-semibold, 600);
          cursor: pointer;
        }
        .camera-overlay__find-btn {
          background: var(--primary, #6e56cf);
          color: var(--text-on-accent, #fff);
        }
        .camera-overlay__find-btn:hover { background: var(--primary-hover, #7c67e0); }
        .camera-overlay__retake-btn {
          background: var(--glass-surface-strong, rgba(255,255,255,0.07));
          color: var(--text-primary, #f5f5f7);
          border: 1px solid var(--border, rgba(255,255,255,0.08));
        }
      `;
      document.head.appendChild(style);
    }

    const overlay = document.createElement('div');
    overlay.className = 'camera-overlay';
    overlay.innerHTML = `
      <div class="camera-overlay__panel">
        <div class="camera-overlay__topbar">
          <button type="button" class="camera-overlay__btn" data-cam-back aria-label="Back to AI Find">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <span class="camera-overlay__title">Take Photo</span>
        </div>
        <div class="camera-overlay__stage">
          <video class="camera-overlay__video" autoplay muted playsinline></video>
          <canvas class="camera-overlay__canvas"></canvas>
          <img class="camera-overlay__preview-img" alt="Captured product" />
          <div class="camera-overlay__hint">Center the product in frame</div>
        </div>
        <div class="camera-overlay__controls">
          <div class="camera-overlay__live-controls">
            <span class="camera-overlay__spacer"></span>
            <button type="button" class="camera-overlay__shutter" data-cam-shutter aria-label="Take photo"></button>
            <button type="button" class="camera-overlay__btn" data-cam-switch aria-label="Switch camera">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
            </button>
          </div>
          <div class="camera-overlay__preview-controls">
            <button type="button" class="camera-overlay__find-btn" data-cam-find>Find</button>
            <button type="button" class="camera-overlay__retake-btn" data-cam-retake>Click Again</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('.camera-overlay__video');
    const previewImg = overlay.querySelector('.camera-overlay__preview-img');
    const backBtn = overlay.querySelector('[data-cam-back]');
    const shutterBtn = overlay.querySelector('[data-cam-shutter]');
    const switchBtn = overlay.querySelector('[data-cam-switch]');
    const findBtn = overlay.querySelector('[data-cam-find]');
    const retakeBtn = overlay.querySelector('[data-cam-retake]');

    // Back button always returns to the AI Find screen (closes the camera,
    // discarding any unconfirmed shot) — works from both live and preview states.
    backBtn.addEventListener('click', closeCamera);
    shutterBtn.addEventListener('click', capturePhoto);
    switchBtn.addEventListener('click', () => {
      cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
      startStream();
    });
    findBtn.addEventListener('click', confirmCapturedPhoto);
    retakeBtn.addEventListener('click', retakePhoto);

    cameraEls = { overlay, video, previewImg, backBtn, shutterBtn, switchBtn, findBtn, retakeBtn };
    return cameraEls;
  }

  function showCameraError(message) {
    const { overlay } = buildCameraOverlay();
    const stage = overlay.querySelector('.camera-overlay__stage');
    let errEl = stage.querySelector('.camera-overlay__error');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'camera-overlay__error';
      stage.appendChild(errEl);
    }
    errEl.textContent = message;
  }

  async function startStream() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    const { video } = buildCameraOverlay();
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: cameraFacing },
        audio: false,
      });
      video.srcObject = cameraStream;
    } catch (err) {
      showCameraError('Camera access was blocked or unavailable. Please allow camera permission and try again.');
    }
  }

  function openCamera() {
    // Native browser camera capture requires getUserMedia; if it isn't available
    // on this device/browser, gracefully fall back to the OS camera capture via
    // the file input (still opens the camera directly, never a redirect).
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      imageInput.setAttribute('capture', 'environment');
      imageInput.click();
      return;
    }
    const { overlay } = buildCameraOverlay();
    overlay.classList.remove('is-preview');
    overlay.classList.add('active');
    capturedBlob = null;
    startStream();
  }

  function closeCamera() {
    if (!cameraEls) return;
    cameraEls.overlay.classList.remove('active', 'is-preview');
    capturedBlob = null;
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
  }

  function capturePhoto() {
    if (!cameraEls || !cameraStream) return;
    const { video, overlay, previewImg } = cameraEls;
    const canvas = overlay.querySelector('.camera-overlay__canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      capturedBlob = blob;
      previewImg.src = URL.createObjectURL(blob);
      overlay.classList.add('is-preview'); // show captured shot + Find / Click Again
    }, 'image/jpeg', 0.92);
  }

  // "Click Again" — discard the captured shot and go back to the live viewfinder
  // (camera stream keeps running, so no extra permission prompt).
  function retakePhoto() {
    if (!cameraEls) return;
    capturedBlob = null;
    cameraEls.overlay.classList.remove('is-preview');
  }

  // "Find" — only now is the captured photo actually used for the AI search:
  // it's handed to the same handleFile() pipeline Upload Image already uses.
  function confirmCapturedPhoto() {
    if (!capturedBlob) return;
    const file = new File([capturedBlob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
    closeCamera();
    handleFile(file);
  }

  imageInput.addEventListener('change', () => {
    handleFile(imageInput.files[0]);
  });

  clearUpload.addEventListener('click', (e) => {
    e.stopPropagation();
    resetToState1(); // removing the uploaded image ends the search session
  });

  // Back button ends the search session too — reset happens alongside the
  // existing app.js navigateHome() (bound to the same [data-back] button),
  // so the Find screen is already back to its initial state by the time the
  // user returns to it.
  const findBackBtn = viewFind.querySelector('.find-back-btn');
  if (findBackBtn) {
    findBackBtn.addEventListener('click', () => resetToState1({ fade: false }));
  }

  // ----- Result / error rendering -----

  function showError(message) {
    findResults.innerHTML = `
      <div class="error-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        <p>${message}</p>
        <p class="error-hint">Check that the PricePulse Node server is running, and try a clear, well-lit product photo.</p>
      </div>
    `;
    findResults.classList.remove('hidden');
  }

  function renderResults(data) {
    const product = data.product || {};
    const title = [product.brand, product.productName].filter(Boolean).join(' ') || 'Product';
    const subtitle = [product.color, product.model].filter(Boolean).join(' · ');
    lastQuery = title;

    const chips = [
      { label: 'Category', value: product.category },
      { label: 'Brand', value: product.brand },
      { label: 'Storage', value: product.storage },
    ].filter(c => c.value);

    const chipsHtml = chips.map(c => `
      <div class="ai-result-chip">
        <span class="ai-result-chip-label">${c.label}</span>
        <span class="ai-result-chip-value">${c.value}</span>
      </div>
    `).join('');

    let html = `
      <div class="ai-result-card">
        ${currentImageData ? `<div class="ai-result-image"><img src="${currentImageData}" alt="${title}" /></div>` : ''}
        <div class="ai-result-info">
          <div class="ai-found-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            AI Found
          </div>
          <h3 class="ai-result-title">${title}</h3>
          ${subtitle ? `<p class="ai-result-subtitle">${subtitle}</p>` : ''}
          ${chipsHtml ? `<div class="ai-result-chips">${chipsHtml}</div>` : ''}
          <div class="ai-result-message">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.7L20 10l-6.2 1.3L12 18l-1.8-6.7L4 10l6.2-1.3z"/></svg>
            <p>Great! We found this product. Compare prices across top platforms.</p>
          </div>
          <button type="button" class="go-compare-btn" id="go-compare-btn">
            Compare Prices
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </button>
        </div>
      </div>

      <div class="search-again-bar">
        <div class="search-again-text">
          <strong>Not the right product?</strong>
          <span>Try a different image or search again</span>
        </div>
        <button type="button" class="search-again-btn" id="search-again-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          Search Again
        </button>
      </div>
    `;

    if (data.searchResults && data.searchResults.length > 0) {
      html += `<div class="web-results-heading">Found across the web</div>`;
      data.searchResults.forEach((item) => {
        html += `
          <a href="${item.link}" target="_blank" class="find-result-item">
            <div class="find-result-info">
              <div class="source">${new URL(item.link).hostname}</div>
              <h4>${item.title}</h4>
              <p>${item.snippet || ""}</p>
            </div>
          </a>
        `;
      });
    }

    findResults.innerHTML = html;
    findResults.classList.remove("hidden");

    const againBtn = document.getElementById('search-again-btn');
    if (againBtn) againBtn.addEventListener('click', () => { resetToState1(); });

    const compareBtn = document.getElementById('go-compare-btn');
    if (compareBtn) {
      compareBtn.addEventListener('click', () => {
        if (window.PricePulse && window.PricePulse.runComparePrefill) {
          // Hand off the full identified product (not just its title) so the
          // Compare page can match store listings against brand/model/variant
          // instead of guessing from a plain string.
          window.PricePulse.runComparePrefill({
            name: title,
            brand: product.brand,
            productName: product.productName,
            model: product.model,
            storage: product.storage,
            color: product.color,
            category: product.category,
          });
        }
        if (window.PricePulse && window.PricePulse.navigateTo) {
          window.PricePulse.navigateTo('compare');
        }
      });
    }
  }

  // Renders a "found" summary for a text-driven search, mirroring the image
  // flow: shows the detected product + a confidence badge, then waits for the
  // user to press Compare Prices before going anywhere near the Compare page.
  function renderTextQueryFound(query) {
    findResults.innerHTML = `
      <div class="ai-result-card">
        <div class="ai-result-info">
          <div class="ai-found-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            AI Found
          </div>
          <h3 class="ai-result-title">${query}</h3>
          <div class="ai-result-message">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.7L20 10l-6.2 1.3L12 18l-1.8-6.7L4 10l6.2-1.3z"/></svg>
            <p>Great! We found this product. Compare prices across top platforms.</p>
          </div>
          <button type="button" class="go-compare-btn" id="go-compare-btn-text">
            Compare Prices
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </button>
        </div>
      </div>
    `;
    findResults.classList.remove('hidden');

    const compareBtn = document.getElementById('go-compare-btn-text');
    if (compareBtn) {
      compareBtn.addEventListener('click', () => {
        if (window.PricePulse && window.PricePulse.runComparePrefill) {
          window.PricePulse.runComparePrefill(query);
        }
        if (window.PricePulse && window.PricePulse.navigateTo) {
          window.PricePulse.navigateTo('compare');
        }
      });
    }
  }

  // ----- Image search (existing AI vision flow) -----

  async function runSearch(e) {
    if (!currentImage) return;

    clearPriorResults(); // in case a previous result/search is still on screen
    searchBtn.disabled = true;
    findLoading.classList.remove('hidden');
    findResults.classList.add('hidden');
    enterSearchingState();
    startStatusCycle(IMAGE_STATUS_MESSAGES);

    try {
      const data = await PricePulseAPI.searchByImage(currentImage);
      // Belt-and-braces: even though PricePulseAPI.searchByImage now rejects
      // non-success responses itself, never let a response missing an
      // actual identified product reach the "Done"/found state.
      const hasIdentity = data && data.product && ((data.product.brand || '').trim() || (data.product.productName || '').trim());
      if (!data || !data.success || !hasIdentity) {
        throw new Error((data && data.error) || "Couldn't identify a product in that photo. Please try again.");
      }
      renderResults(data);
      exitSearchingState();
      enterFoundState();
    } catch (err) {
      exitSearchingState();
      showError(err.message);
      orbCaption.textContent = 'Ready to help…';
      orbAiLabel.classList.remove('hidden');
      setActiveOrbVideo('idle');
      clearUpload.disabled = false; // unlock "remove photo" — scan didn't complete successfully
    }

    findLoading.classList.add('hidden');
    searchBtn.disabled = false;
  }

  searchBtn.addEventListener("click", function (e) {
    e.preventDefault();
    runSearch(e);
  });

  // ----- Text search (new: describe bar + suggestion chips) -----

  async function runTextSearch(query) {
    query = (query || '').trim();
    if (!query) return;

    clearPriorResults(); // in case a previous result/search is still on screen
    findLoading.classList.remove('hidden');
    findResults.classList.add('hidden');
    enterSearchingState();
    startStatusCycle(TEXT_STATUS_MESSAGES);

    // Brief on-page moment so the orb/transition reads as a real search, then
    // the product is shown right here for review. The actual price lookup on
    // the Compare screen only happens once the user presses Compare Prices.
    await new Promise((r) => setTimeout(r, TEXT_STATUS_MESSAGES.length * 1000));

    exitSearchingState();
    enterFoundState();
    findLoading.classList.add('hidden');
    renderTextQueryFound(query);
  }

  describeSubmit.addEventListener('click', () => runTextSearch(describeInput.value));
  describeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTextSearch(describeInput.value);
  });

  suggestionChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      describeInput.value = chip.textContent.trim();
      runTextSearch(chip.textContent.trim());
    });
  });

})();
