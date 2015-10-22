'use strict';

var TabState = require('./tab-state');
var BrowserAction = require('./browser-action');
var HelpPage = require('./help-page');
var settings = require('./settings');
var SidebarInjector = require('./sidebar-injector');
var TabErrorCache = require('./tab-error-cache');
var TabStore = require('./tab-store');

var TAB_STATUS_LOADING = 'loading';
var TAB_STATUS_COMPLETE = 'complete';

/* The main extension application. This wires together all the smaller
 * modules. The app listens to all new created/updated/removed tab events
 * and uses the TabState object to keep track of whether the sidebar is
 * active or inactive in the tab. The app also listens to click events on
 * the browser action and toggles the state and uses the BrowserAction module
 * to update the visual style of the button.
 *
 * The SidebarInjector handles the insertion of the Hypothesis code. If it
 * runs into errors the tab is put into an errored state and when the
 * browser action is clicked again the HelpPage module displays more
 * information to the user.
 *
 * Lastly the TabStore listens to changes to the TabState module and persists
 * the current settings to localStorage. This is then loaded into the
 * application on startup.
 *
 * Relevant Chrome Extension documentation:
 * - https://developer.chrome.com/extensions/browserAction
 * - https://developer.chrome.com/extensions/tabs
 * - https://developer.chrome.com/extensions/extension
 *
 * dependencies - An object to set up the application.
 *   chromeTabs: An instance of chrome.tabs.
 *   chromeBrowserAction: An instance of chrome.browserAction.
 *   extensionURL: chrome.extension.getURL.
 *   isAllowedFileSchemeAccess: chrome.extension.isAllowedFileSchemeAccess.
 */
function HypothesisChromeExtension(dependencies) {
  var chromeTabs = dependencies.chromeTabs;
  var chromeBrowserAction = dependencies.chromeBrowserAction;
  var help  = new HelpPage(chromeTabs, dependencies.extensionURL);
  var store = new TabStore(localStorage);
  var state = new TabState(store.all(), onTabStateChange);
  var browserAction = new BrowserAction(chromeBrowserAction);
  var sidebar = new SidebarInjector(chromeTabs, {
    extensionURL: dependencies.extensionURL,
    isAllowedFileSchemeAccess: dependencies.isAllowedFileSchemeAccess,
  });
  var tabErrors = new TabErrorCache();

  /* Sets up the extension and binds event listeners. Requires a window
   * object to be passed so that it can listen for localStorage events.
   */
  this.listen = function (window) {
    chromeBrowserAction.onClicked.addListener(onBrowserActionClicked);
    chromeTabs.onCreated.addListener(onTabCreated);

    // when a user navigates within an existing tab,
    // onUpdated is fired in most cases
    chromeTabs.onUpdated.addListener(onTabUpdated);

    // ... but when a user navigates to a page that is loaded
    // via prerendering or instant results, onTabReplaced is
    // fired instead. See https://developer.chrome.com/extensions/tabs#event-onReplaced
    // and https://code.google.com/p/chromium/issues/detail?id=109557
    chromeTabs.onReplaced.addListener(onTabReplaced);

    chromeTabs.onRemoved.addListener(onTabRemoved);

    // FIXME: Find out why we used to reload the data on every get.
    window.addEventListener('storage', function (event) {
      var key = 'state';
      var isState = event.key === key;
      var isUpdate = event.newValue !== null;

      // Check the event is for the store and check that something has
      // actually changed externally by validating the new value.
      if (isState && isUpdate && event.newValue !== JSON.stringify(store.all())) {
        store.reload();
        state.load(store.all());
      }
    });
  };

  /* A method that can be used to setup the extension on existing tabs
   * when the extension is installed.
   */
  this.install = function () {
    chromeTabs.query({}, function (tabs) {
      tabs.forEach(function (tab) {
        if (state.isTabActive(tab.id)) {
          state.activateTab(tab.id);
        } else {
          state.deactivateTab(tab.id);
        }
      });
    });
  };

  /* Opens the onboarding page */
  this.firstRun = function () {
    chromeTabs.create({url: 'https://hypothes.is/welcome'}, function (tab) {
      state.activateTab(tab.id);
    });
  };

  function onTabStateChange(tabId, current, previous) {
    if (current) {
      browserAction.update(tabId, current);

      if (!state.isTabErrored(tabId)) {
        store.set(tabId, current);
        tabErrors.unsetTabError(tabId);
        chromeTabs.get(tabId, updateTabDocument);
      }
    } else {
      store.unset(tabId);
      tabErrors.unsetTabError(tabId);
    }
  }

  // exposed for use by tests
  this._onTabStateChange = onTabStateChange;

  function onBrowserActionClicked(tab) {
    var tabError = tabErrors.getTabError(tab.id);
    if (state.isTabErrored(tab.id) && tabError) {
      help.showHelpForError(tab, tabError);
    }
    else if (state.isTabActive(tab.id)) {
      state.deactivateTab(tab.id);
    }
    else {
      state.activateTab(tab.id);
    }
  }

  function resetTabState(tabId, url) {
    var activeState = state.getState(tabId).state;
    if (activeState === TabState.states.ERRORED) {
      activeState = TabState.states.ACTIVE;
    }

    state.setState(tabId, {
      state: activeState,
      ready: false,
      annotationCount: 0,
      extensionSidebarInstalled: false,
    });

    settings.then(function(settings) {
      state.updateAnnotationCount(tabId, url, settings.apiUrl);
    });
  }

  // This function will be called multiple times as the tab reloads.
  // https://developer.chrome.com/extensions/tabs#event-onUpdated
  //
  // 'changeInfo' contains details of what changed about the tab's status.
  // Two important events are when the tab's `status` changes to `loading`
  // when the user begins a new navigation and when the tab's status changes
  // to `complete` after the user completes a navigation
  function onTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status === TAB_STATUS_LOADING) {
      resetTabState(tabId, tab.url);
    } else if (changeInfo.status === TAB_STATUS_COMPLETE) {
      state.setState(tabId, {
        ready: true,
      });
    }
  }

  function onTabReplaced(addedTabId, removedTabId) {
    var activeState = state.getState(removedTabId).state;
    state.clearTab(removedTabId);
    state.setState(addedTabId, {
      state: activeState,
      ready: true,
    });

    settings.then(function (settings) {
      chromeTabs.get(addedTabId, function (tab) {
        state.updateAnnotationCount(addedTabId, tab.url, settings.apiUrl);
      });
    });
  }

  function onTabCreated(tab) {
    // Clear the state in case there is old, conflicting data in storage.
    state.clearTab(tab.id);
  }

  function onTabRemoved(tabId) {
    state.clearTab(tabId);
  }

  function updateTabDocument(tab) {
    // If the tab has not yet finished loading then just quietly return.
    if (tab.status !== TAB_STATUS_COMPLETE) {
      return Promise.resolve();
    }

    var isInstalled = state.getState(tab.id).extensionSidebarInstalled;
    if (state.isTabActive(tab.id) && !isInstalled) {
      // optimistically set the state flag indicating that the sidebar
      // has been installed
      state.setState(tab.id, {
        extensionSidebarInstalled: true,
      });
      return sidebar.injectIntoTab(tab)
        .catch(function (err) {
          tabErrors.setTabError(tab.id, err);
          state.errorTab(tab.id);
        });
    }
    else if (state.isTabInactive(tab.id) && isInstalled) {
      return sidebar.removeFromTab(tab).then(function () {
        state.setState(tab.id, {
          extensionSidebarInstalled: false,
        });
      });
    }
  }
}

module.exports = HypothesisChromeExtension;
