// ─── Main entry point ───
import { goTo }  from './helpers.js';
import { S }     from './state.js';

import {
  initAuth, firebaseLogin, firebaseSignup, childLogin, addChildInput, logout,
  openParentLoginPopup, closeParentLoginPopup, parentLoginFromPopup,
  showForgotPassword, backToLogin, sendPasswordReset,
  openSignupPopup, closeSignupPopup, backToLoginFromSignup, firebaseSignupPopup,
  toggleParentTheme, openAddChildPopup, closeAddChildPopup, submitAddChild,
  famCodeLogin,
  openSettingsPopup, closeSettingsPopup, confirmDeleteChild, confirmDeleteAccount
} from './auth.js';

import { setMode, startReading, stopReading, cancelReading, saveSession, skipSave } from './child-view.js';

import {
  toggleExpand, playClip, toggleCodes,
  phPlayClip, switchTab, toggleRec, selectChild, renderDashboard,
  switchHeatmap, switchHeatmapMonth,
  setRecDays, toggleRecFavFilter, toggleFav
} from './parent-view.js';

// ── Global functions ──
window.goTo                  = goTo;
window.firebaseLogin         = firebaseLogin;
window.firebaseSignup        = firebaseSignup;
window.childLogin            = childLogin;
window.addChildInput         = addChildInput;
window.logout                = logout;

window.openParentLoginPopup  = openParentLoginPopup;
window.closeParentLoginPopup = closeParentLoginPopup;
window.parentLoginFromPopup  = parentLoginFromPopup;
window.showForgotPassword    = showForgotPassword;
window.backToLogin           = backToLogin;
window.sendPasswordReset     = sendPasswordReset;

window.openSignupPopup       = openSignupPopup;
window.closeSignupPopup      = closeSignupPopup;
window.backToLoginFromSignup = backToLoginFromSignup;
window.firebaseSignupPopup   = firebaseSignupPopup;

window.toggleParentTheme     = toggleParentTheme;
window.openAddChildPopup     = openAddChildPopup;
window.closeAddChildPopup    = closeAddChildPopup;
window.submitAddChild        = submitAddChild;

window.famCodeLogin          = famCodeLogin;

window.openSettingsPopup     = openSettingsPopup;
window.closeSettingsPopup    = closeSettingsPopup;
window.confirmDeleteChild    = confirmDeleteChild;
window.confirmDeleteAccount  = confirmDeleteAccount;

window.selectChild           = selectChild;
window.switchTab             = switchTab;
window.toggleRec             = toggleRec;
window.phPlayClip            = phPlayClip;
window.renderDashboard       = renderDashboard;
window.switchHeatmap         = switchHeatmap;
window.switchHeatmapMonth    = switchHeatmapMonth;
window.setRecDays            = setRecDays;
window.toggleRecFavFilter    = toggleRecFavFilter;
window.toggleFav             = toggleFav;

window.toggleExpand          = toggleExpand;
window.playClip              = playClip;
window.toggleCodes           = toggleCodes;

window.setMode               = setMode;
window.startReading          = startReading;
window.stopReading           = stopReading;
window.cancelReading         = cancelReading;
window.saveSession           = saveSession;
window.skipSave              = skipSave;

window.activateChildLoginInputGlow = function() {
  const wrap = document.querySelector('.cl-wrap');
  if (!wrap) return;
  wrap.classList.add('is-engaged');
};

window.setAgeMode = function(mode) {
  if (mode !== 'kids' && mode !== 'teens') return;
  S.ageMode = mode;
  localStorage.setItem('upphatt_age_mode', mode);
  const kidsBtn  = document.getElementById('age-kids-btn');
  const teensBtn = document.getElementById('age-teens-btn');
  if (mode === 'teens') {
    document.body.classList.add('theme-teens');
    if (kidsBtn)  kidsBtn.classList.remove('active');
    if (teensBtn) teensBtn.classList.add('active');
  } else {
    document.body.classList.remove('theme-teens');
    if (teensBtn) teensBtn.classList.remove('active');
    if (kidsBtn)  kidsBtn.classList.add('active');
  }
};

window.toggleSessionsList = function() {
  const list = document.getElementById('child-sessions-list');
  const btn  = document.getElementById('sessions-toggle-btn');
  if (!list) return;
  if (list.style.display === 'none') {
    list.style.display = 'block';
    if (btn) btn.textContent = 'Minna ▲';
  } else {
    list.style.display = 'none';
    if (btn) btn.textContent = 'Meira ▼';
  }
};

// ── Init ──
const savedMode = localStorage.getItem('upphatt_age_mode');
window.setAgeMode(savedMode === 'teens' ? 'teens' : 'kids');
initAuth();
