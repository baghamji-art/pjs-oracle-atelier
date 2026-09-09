/* Sanitize only persisted, untrusted result snapshots. Live renderers stay unchanged. */
(function () {
  'use strict';

  function restore(cardsTarget, readingTarget, cardsHtml, readingHtml) {
    if (!window.DOMPurify || !window.DOMPurify.isSupported) {
      throw new Error('Archive sanitizer unavailable');
    }
    if (!cardsTarget || !readingTarget || typeof cardsHtml !== 'string' || typeof readingHtml !== 'string') {
      throw new Error('Invalid archive snapshot');
    }
    var options = {
      RETURN_DOM_FRAGMENT: true,
      ALLOW_DATA_ATTR: true,
      ALLOW_ARIA_ATTR: true,
      SANITIZE_DOM: true,
      FORBID_TAGS: ['style', 'link', 'meta', 'base', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['srcdoc', 'autofocus', 'formaction', 'form']
    };
    // Prepare both fragments before changing either target; never fall back to raw HTML.
    var cards = window.DOMPurify.sanitize(cardsHtml, options);
    var reading = window.DOMPurify.sanitize(readingHtml, options);
    cardsTarget.replaceChildren(cards);
    readingTarget.replaceChildren(reading);
  }

  window.PJArchiveSecurity = Object.freeze({ restore: restore });
})();
