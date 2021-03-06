import { Game } from '@database/entity/Game';
import { Playlist } from '@database/entity/Playlist';
import { PlaylistGame } from '@database/entity/PlaylistGame';
import { BackIn, BackInit, BackOut, BrowseViewKeysetData, BrowseViewKeysetResponse, BrowseViewPageData, BrowseViewPageResponseData, DeleteGameData, DevConsoleStatusResponse, ExportMetaEditData, GetGamesTotalResponseData, GetPlaylistsResponse, GetSuggestionsResponseData, InitEventData, LanguageChangeData, LanguageListChangeData, LaunchGameData, LocaleUpdateData, LogEntryAddedData, PlaylistsChangeData, RandomGamesData, RandomGamesResponseData, SaveGameData, SavePlaylistGameData, ServiceChangeData, TagCategoriesChangeData, ThemeChangeData, ThemeListChangeData, UpdateConfigData } from '@shared/back/types';
import { APP_TITLE, VIEW_PAGE_SIZE } from '@shared/constants';
import { ProcessState, WindowIPC } from '@shared/interfaces';
import { LangContainer } from '@shared/lang';
import { memoizeOne } from '@shared/memoize';
import { updatePreferencesData } from '@shared/preferences/util';
import { setTheme } from '@shared/Theme';
import { getUpgradeString } from '@shared/upgrade/util';
import { canReadWrite, deepCopy, getFileServerURL, recursiveReplace } from '@shared/Util';
import { arrayShallowStrictEquals } from '@shared/utils/compare';
import { debounce } from '@shared/utils/debounce';
import { formatString } from '@shared/utils/StringFormatter';
import { ipcRenderer, remote } from 'electron';
import { AppUpdater } from 'electron-updater';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as React from 'react';
import { RouteComponentProps } from 'react-router-dom';
import * as which from 'which';
import { GameOrderChangeEvent } from './components/GameOrder';
import { MetaEditExporter, MetaEditExporterConfirmData } from './components/MetaEditExporter';
import { SplashScreen } from './components/SplashScreen';
import { TitleBar } from './components/TitleBar';
import { ConnectedFooter } from './containers/ConnectedFooter';
import HeaderContainer from './containers/HeaderContainer';
import { WithMainStateProps } from './containers/withMainState';
import { WithPreferencesProps } from './containers/withPreferences';
import { WithTagCategoriesProps } from './containers/withTagCategories';
import { CreditsFile } from './credits/CreditsFile';
import { UpdateView, UpgradeStageState } from './interfaces';
import { Paths } from './Paths';
import { AppRouter, AppRouterProps } from './router';
import { MainActionType, RequestState } from './store/main/enums';
import { MainState } from './store/main/types';
import { SearchQuery } from './store/search';
import { UpgradeStage } from './upgrade/types';
import { UpgradeFile } from './upgrade/UpgradeFile';
import { getBrowseSubPath, isFlashpointValidCheck, joinLibraryRoute, openConfirmDialog } from './Util';
import { LangContext } from './util/lang';
import { checkUpgradeStateInstalled, checkUpgradeStateUpdated, downloadAndInstallUpgrade } from './util/upgrade';

const autoUpdater: AppUpdater = remote.require('electron-updater').autoUpdater;

type AppOwnProps = {
  /** Most recent search query. */
  search: SearchQuery;
};

export type AppProps = AppOwnProps & RouteComponentProps & WithPreferencesProps & WithTagCategoriesProps & WithMainStateProps;

export class App extends React.Component<AppProps> {
  constructor(props: AppProps) {
    super(props);

    // Initialize app
    this.init();
  }

  init() {
    const strings = this.props.main.lang;
    const fullFlashpointPath = window.Shared.config.fullFlashpointPath;
    const fullJsonFolderPath = window.Shared.config.fullJsonFolderPath;
    // Warn the user when closing the launcher WHILE downloading or installing an upgrade
    (() => {
      let askBeforeClosing = true;
      window.onbeforeunload = (event: BeforeUnloadEvent) => {
        const { upgrades } = this.props.main;
        let stillDownloading = false;
        for (const stage of upgrades) {
          if (stage.state.isInstalling) {
            stillDownloading = true;
            break;
          }
        }
        if (askBeforeClosing && stillDownloading) {
          event.returnValue = 1; // (Prevent closing the window)
          remote.dialog.showMessageBox({
            type: 'warning',
            title: 'Exit Launcher?',
            message: 'All progress on downloading or installing the upgrade will be lost.\n'+
                     'Are you sure you want to exit?',
            buttons: ['Yes', 'No'],
            defaultId: 1,
            cancelId: 1,
          })
          .then(({ response }) => {
            if (response === 0) {
              askBeforeClosing = false;
              this.unmountBeforeClose();
            }
          });
        } else {
          this.unmountBeforeClose();
        }
      };
    })();
    // Listen for the window to move or resize (and update the preferences when it does)
    ipcRenderer.on(WindowIPC.WINDOW_MOVE, debounce((sender, x: number, y: number, isMaximized: boolean) => {
      if (!isMaximized) {
        updatePreferencesData({ mainWindow: { x: x|0, y: y|0 } });
      }
    }, 100));
    ipcRenderer.on(WindowIPC.WINDOW_RESIZE, debounce((sender, width: number, height: number, isMaximized: boolean) => {
      if (!isMaximized) {
        updatePreferencesData({ mainWindow: { width: width|0, height: height|0 } });
      }
    }, 100));
    ipcRenderer.on(WindowIPC.WINDOW_MAXIMIZE, (sender, isMaximized: boolean) => {
      updatePreferencesData({ mainWindow: { maximized: isMaximized } });
    });

    window.Shared.back.send<InitEventData>(BackIn.INIT_LISTEN, undefined, res => {
      if (!res.data) { throw new Error('INIT_LISTEN response is missing data.'); }
      this.props.dispatchMain({
        type: MainActionType.ADD_LOADED,
        loaded: res.data.done,
      });
    });

    window.Shared.back.send<GetGamesTotalResponseData>(BackIn.GET_GAMES_TOTAL, undefined, res => {
      if (res.data) {
        this.props.dispatchMain({
          type: MainActionType.SET_GAMES_TOTAL,
          total: res.data,
        });
      }
    });

    window.Shared.back.send<GetSuggestionsResponseData>(BackIn.GET_SUGGESTIONS, undefined, res => {
      if (res.data) {
        this.props.dispatchMain({
          type: MainActionType.SET_SUGGESTIONS,
          suggestions: res.data.suggestions,
          appPaths: res.data.appPaths,
        });
      }
    });

    window.Shared.back.on('message', res => {
      // console.log('IN', res);
      switch (res.type) {
        case BackOut.INIT_EVENT: {
          const resData: InitEventData = res.data;

          for (const index of resData.done) {
            switch (parseInt(index+'', 10)) { // (It is a string, even though TS thinks it is a number)
              case BackInit.PLAYLISTS:
                window.Shared.back.send<GetPlaylistsResponse>(BackIn.GET_PLAYLISTS, undefined, res => {
                  if (res.data) {
                    this.props.setMainState({ playlists: res.data });
                    this.cachePlaylistIcons(res.data);
                  }
                });
                break;
            }
          }

          this.props.dispatchMain({
            type: MainActionType.ADD_LOADED,
            loaded: resData.done,
          });
        } break;

        case BackOut.LOG_ENTRY_ADDED: {
          const resData: LogEntryAddedData = res.data;
          window.Shared.log.entries[resData.index - window.Shared.log.offset] = resData.entry;
        } break;

        case BackOut.LOCALE_UPDATE: {
          const resData: LocaleUpdateData = res.data;
          this.props.dispatchMain({
            type: MainActionType.SET_LOCALE,
            localeCode: resData,
          });
        } break;

        case BackOut.SERVICE_CHANGE: {
          const resData: ServiceChangeData = res.data;
          if (resData.id) {
            const service = window.Shared.services.find(item => item.id === resData.id);
            if (service) {
              recursiveReplace(service, resData);
            } else {
              window.Shared.services.push(recursiveReplace({
                id: 'invalid',
                name: 'Invalid',
                state: ProcessState.STOPPED,
                pid: -1,
                startTime: 0,
                info: {
                  path: '',
                  filename: '',
                  arguments: [],
                  kill: false,
                },
              }, resData));
            }
          } else { throw new Error('Service update did not reference a service.'); }
        } break;

        case BackOut.SERVICE_REMOVED: {
          const id: string = res.data;
          const index = window.Shared.services.findIndex(s => s.id === id);
          if (index > -1) {
            window.Shared.services.splice(index, 1);
          }
        } break;

        case BackOut.LANGUAGE_CHANGE: {
          const resData: LanguageChangeData = res.data;
          this.props.dispatchMain({
            type: MainActionType.SET_LANGUAGE,
            lang: resData,
          });
        } break;

        case BackOut.LANGUAGE_LIST_CHANGE: {
          const resData: LanguageListChangeData = res.data;
          this.props.dispatchMain({
            type: MainActionType.SET_LANGUAGE_LIST,
            langList: resData,
          });
        } break;

        case BackOut.THEME_CHANGE: {
          const resData: ThemeChangeData = res.data;
          if (resData.id === this.props.preferencesData.currentTheme) { setTheme(resData); }
        } break;

        case BackOut.THEME_LIST_CHANGE: {
          const resData: ThemeListChangeData = res.data;
          this.props.dispatchMain({
            type: MainActionType.SET_THEME_LIST,
            themeList: resData,
          });
        } break;

        case BackOut.PLAYLISTS_CHANGE: {
          const resData: PlaylistsChangeData = res.data;
          this.props.dispatchMain({
            type: MainActionType.SET_PLAYLISTS,
            playlists: resData,
          });
          this.cachePlaylistIcons(resData);
        } break;

        case BackOut.TAG_CATEGORIES_CHANGE: {
          const resData: TagCategoriesChangeData = res.data;
          this.props.setTagCategories(resData);
        } break;

        case BackOut.DEV_CONSOLE_CHANGE: {
          const resData: DevConsoleStatusResponse = res.data;
          this.props.setMainState({ devConsoleText: resData.text });
        }
      }
    });

    // Cache playlist icons (if they are loaded)
    if (this.props.main.playlists.length > 0) { this.cachePlaylistIcons(this.props.main.playlists); }

    // -- Stuff that should probably be moved to the back --

    // Load Upgrades
    const folderPath = window.Shared.isDev
      ? process.cwd()
      : path.dirname(remote.app.getPath('exe'));
    const upgradeCatch = (error: Error) => { console.warn(error); };
    const launcherLogFunc = (message: string) => {
      log.warn('Launcher', message);
    };
    Promise.all([UpgradeFile.readFile(folderPath, launcherLogFunc), UpgradeFile.readFile(fullJsonFolderPath, launcherLogFunc)].map(p => p.catch(upgradeCatch)))
    .then(async (fileData) => {
      // Combine all file data
      let allData: UpgradeStage[] = [];
      for (const data of fileData) {
        if (data) {
          allData = allData.concat(data);
        }
      }
      this.props.dispatchMain({
        type: MainActionType.SET_UPGRADES,
        upgrades: allData,
      });
      const isValid = await isFlashpointValidCheck(window.Shared.config.data.flashpointPath);
      // Notify of downloading initial data (if available)
      if (!isValid && allData.length > 0) {
        remote.dialog.showMessageBox({
          type: 'info',
          title: strings.dialog.dataRequired,
          message: strings.dialog.dataRequiredDesc,
          buttons: [strings.misc.yes, strings.misc.no]
        })
        .then((res) => {
          if (res.response === 0) {
            this.onDownloadUpgradeClick(allData[0], strings);
          }
        });
      }
      // Do existance checks on all upgrades
      await Promise.all(allData.map(async upgrade => {
        const baseFolder = fullFlashpointPath;
        // Perform install checks
        const installed = await checkUpgradeStateInstalled(upgrade, baseFolder);
        this.setUpgradeStageState(upgrade.id, {
          alreadyInstalled: installed,
          checksDone: true
        });
        // If installed, check for updates
        if (installed) {
          const upToDate = await checkUpgradeStateUpdated(upgrade, baseFolder);
          this.setUpgradeStageState(upgrade.id, {
            upToDate: upToDate
          });
        }
      }));
    });

    // Load Credits
    fetch(`${getFileServerURL()}/credits.json`)
    .then(res => res.json())
    .then(async (data) => {
      this.props.dispatchMain({
        type: MainActionType.SET_CREDITS,
        creditsData: CreditsFile.parseCreditsData(data),
      });
    })
    .catch((error) => {
      console.warn(error);
      log.warn('Launcher', `Failed to load credits.\n${error}`);
      this.props.dispatchMain({ type: MainActionType.SET_CREDITS });
    });

    // Updater code - DO NOT run in development environment!
    if (!window.Shared.isDev) {
      autoUpdater.autoDownload = false;
      autoUpdater.on('error', (error: Error) => {
        console.log(error);
      });
      autoUpdater.on('update-available', (info) => {
        log.info('Launcher', `Update Available - ${info.version}`);
        console.log(info);
        this.props.dispatchMain({
          type: MainActionType.SET_UPDATE_INFO,
          updateInfo: info,
        });
      });
      autoUpdater.on('update-downloaded', onUpdateDownloaded);
      if (window.Shared.config.data.updatesEnabled) {
        autoUpdater.checkForUpdates()
        .catch((error) => { log.error('Launcher', `Error Fetching Update Info - ${error.message}`); });
        log.info('Launcher', 'Checking for updates...');
      } else {
        log.info('Launcher', 'Update check disabled, skipping...');
      }
    }

    // Check for Wine and PHP on Linux/Mac
    if (process.platform !== 'win32') {
      which('php', function(err: Error | null) {
        if (err) {
          log.warn('Launcher', 'Warning: PHP not found in path, may cause unexpected behaviour.');
          remote.dialog.showMessageBox({
            type: 'error',
            title: strings.dialog.programNotFound,
            message: strings.dialog.phpNotFound,
            buttons: ['Ok']
          } );
        }
      });
    }

    this.props.setTagCategories(window.Shared.initialTagCategories);
  }

  componentDidMount() {
    // Call first batch of random games
    if (this.props.main.randomGames.length < 5) { this.rollRandomGames(true); }
  }

  componentDidUpdate(prevProps: AppProps) {
    const { history, location, preferencesData } = this.props;
    const library = getBrowseSubPath(this.props.location.pathname);
    const view = this.props.main.views[library];

    // Check if theme changed
    if (preferencesData.currentTheme !== prevProps.preferencesData.currentTheme) {
      const theme = this.props.main.themeList.find(t => t.id === preferencesData.currentTheme);
      setTheme(theme);
    }

    // Check if logo set changed
    if (preferencesData.currentLogoSet !== prevProps.preferencesData.currentLogoSet) {
      this.props.dispatchMain({
        type: MainActionType.INCREMENT_LOGO_VERSION
      });
    }


    // Check if renderer finished initializing
    if (isInitDone(this.props.main) && !isInitDone(prevProps.main)) {
      // Pre-request all libraries
      for (const library of this.props.main.libraries) {
        this.setViewQuery(library);
      }
    }

    if (view) {
      // Check if any parameters for the search query has changed (they don't match the current view's)
      if (view.query.text                   !== this.props.search.text ||
          view.query.extreme                !== this.props.preferencesData.browsePageShowExtreme ||
          view.query.orderBy                !== this.props.preferencesData.gamesOrderBy ||
          view.query.orderReverse           !== this.props.preferencesData.gamesOrder ||
          prevProps.main.playlists          !== this.props.main.playlists) {
        this.setViewQuery(library);
      }
      // Fetch pages
      else if (view.metaState === RequestState.RECEIVED) {
        let pages: number[] | undefined;

        for (const index in view.pageState) {
          if (view.pageState[index] === RequestState.WAITING) {
            if (!pages) { pages = []; }
            pages.push(+index);
          }
        }

        if (pages && pages.length > 0) {
          // Request pages
          window.Shared.back.sendP<BrowseViewPageResponseData<boolean>, BrowseViewPageData>(BackIn.BROWSE_VIEW_PAGE, {
            ranges: pages.map(index => ({
              start: index * VIEW_PAGE_SIZE,
              length: VIEW_PAGE_SIZE,
              index: view.meta && view.meta.pageKeyset[index + 1], // Page keyset indices are one-indexed (start at 1 instead of 0)
            })),
            library: library,
            query: view.query,
            shallow: true,
          }).then((res) => {
            if (res.data) {
              this.props.dispatchMain({
                type: MainActionType.ADD_VIEW_PAGES,
                library: library,
                queryId: view.queryId,
                ranges: res.data.ranges,
              });
            } else {
              console.error('BROWSE_VIEW_PAGE response contains no data.');
            }
          });

          // Flag pages as requested
          this.props.dispatchMain({
            type: MainActionType.REQUEST_VIEW_PAGES,
            library: library,
            queryId: view.queryId,
            pages: pages,
          });
        }
      }
    }

    for (const l in this.props.main.views) {
      const v = this.props.main.views[l];
      // Check if the meta has not yet been requested
      if (v && v.metaState === RequestState.WAITING) {
        // Request meta
        window.Shared.back.sendP<BrowseViewKeysetResponse, BrowseViewKeysetData>(BackIn.BROWSE_VIEW_KEYSET, {
          query: v.query,
          library: l,
        }).then((res) => {
          if (res.data) {
            this.props.dispatchMain({
              type: MainActionType.SET_VIEW_META,
              library: l,
              queryId: v.queryId,
              keyset: res.data.keyset,
              total: res.data.total,
            });
          }
        });

        // Flag meta as requested
        this.props.dispatchMain({
          type: MainActionType.REQUEST_VIEW_META,
          library: l,
          queryId: v.queryId,
        });
      }
    }

    // Update preference "lastSelectedLibrary"
    const gameLibrary = getBrowseSubPath(location.pathname);
    if (location.pathname.startsWith(Paths.BROWSE) &&
        preferencesData.lastSelectedLibrary !== gameLibrary) {
      updatePreferencesData({ lastSelectedLibrary: gameLibrary });
    }

    // Create a new game
    if (this.props.main.wasNewGameClicked) {
      const route = preferencesData.lastSelectedLibrary || preferencesData.defaultLibrary || '';

      if (location.pathname.startsWith(Paths.BROWSE)) {
        this.props.dispatchMain({ type: MainActionType.CLICK_NEW_GAME_END });
        // Deselect the current game
        const view = this.props.main.views[route];
        if (view && view.selectedGameId !== undefined) {
          this.props.dispatchMain({
            type: MainActionType.SET_VIEW_SELECTED_GAME,
            library: route,
            gameId: undefined,
          });
        }
      } else {
        history.push(joinLibraryRoute(route));
      }
    }

    // Clear random picks queue
    if (this.props.main.randomGames.length > 5 && (
      this.props.preferencesData.browsePageShowExtreme !== prevProps.preferencesData.browsePageShowExtreme ||
      !arrayShallowStrictEquals(this.props.preferencesData.excludedRandomLibraries, prevProps.preferencesData.excludedRandomLibraries)
    )) {
      this.props.dispatchMain({ type: MainActionType.CLEAR_RANDOM_GAMES });
    }
  }

  render() {
    const loaded = isInitDone(this.props.main);
    const libraryPath = getBrowseSubPath(this.props.location.pathname);
    const view = this.props.main.views[libraryPath];
    const playlists = this.filterAndOrderPlaylistsMemo(this.props.main.playlists, libraryPath);

    // Props to set to the router
    const routerProps: AppRouterProps = {
      games: view && view.games || {},
      randomGames: this.props.main.randomGames,
      rollRandomGames: this.rollRandomGames,
      updateView: this.updateView,
      gamesTotal: view && view.total || 0,
      playlists: playlists,
      suggestions: this.props.main.suggestions,
      appPaths: this.props.main.appPaths,
      platforms: this.props.main.platforms,
      platformsFlat: this.flattenPlatformsMemo(this.props.main.platforms),
      playlistIconCache: this.props.main.playlistIconCache,
      onSaveGame: this.onSaveGame,
      onDeleteGame: this.onDeleteGame,
      onLaunchGame: this.onLaunchGame,
      onQuickSearch: this.onQuickSearch,
      onOpenExportMetaEdit: this.onOpenExportMetaEdit,
      libraries: this.props.main.libraries,
      serverNames: this.props.main.serverNames,
      mad4fpEnabled: this.props.main.mad4fpEnabled,
      localeCode: this.props.main.localeCode,
      devConsoleText: this.props.main.devConsoleText,
      upgrades: this.props.main.upgrades,
      creditsData: this.props.main.creditsData,
      creditsDoneLoading: this.props.main.creditsDoneLoading,
      selectedGameId: view && view.selectedGameId,
      selectedPlaylistId: view && view.query.filter.playlistId,
      onSelectGame: this.onSelectGame,
      onDeletePlaylist: this.onPlaylistDelete,
      onUpdatePlaylist: this.onUpdatePlaylist,
      onSelectPlaylist: this.onSelectPlaylist,
      wasNewGameClicked: this.props.main.wasNewGameClicked,
      onDownloadUpgradeClick: this.onDownloadUpgradeClick,
      gameLibrary: libraryPath,
      themeList: this.props.main.themeList,
      languages: this.props.main.langList,
      updateInfo: this.props.main.updateInfo,
      autoUpdater: autoUpdater,
      extensions: this.props.main.extensions,
      devScripts: this.props.main.devScripts,
      logoSets: this.props.main.logoSets,
      logoVersion: this.props.main.logoVersion,
    };

    // Render
    return (
      <LangContext.Provider value={this.props.main.lang}>
        { !this.props.main.stopRender ? (
          <>
            {/* Splash screen */}
            <SplashScreen
              gamesLoaded={this.props.main.gamesDoneLoading}
              upgradesLoaded={this.props.main.upgradesDoneLoading}
              creditsLoaded={this.props.main.creditsDoneLoading}
              miscLoaded={this.props.main.loaded[BackInit.EXEC]} />
            {/* Title-bar (if enabled) */}
            { window.Shared.config.data.useCustomTitlebar ?
              window.Shared.customVersion ? (
                <TitleBar title={window.Shared.customVersion} />
              ) : (
                <TitleBar title={`${APP_TITLE} (${remote.app.getVersion()})`} />
              ) : undefined }
            {/* "Content" */}
            { loaded ? (
              <>
                {/* Header */}
                <HeaderContainer
                  libraries={this.props.main.libraries}
                  onOrderChange={this.onOrderChange}
                  onToggleLeftSidebarClick={this.onToggleLeftSidebarClick}
                  onToggleRightSidebarClick={this.onToggleRightSidebarClick}
                  orderBy={this.props.preferencesData.gamesOrderBy}
                  orderReverse={this.props.preferencesData.gamesOrder} />
                {/* Main */}
                <div className='main'>
                  <AppRouter { ...routerProps } />
                  <noscript className='nojs'>
                    <div style={{textAlign:'center'}}>
                      This website requires JavaScript to be enabled.
                    </div>
                  </noscript>
                </div>
                {/* Footer */}
                <ConnectedFooter />
                {/* Meta Edit Popup */}
                { this.props.main.metaEditExporterOpen ? (
                  <MetaEditExporter
                    gameId={this.props.main.metaEditExporterGameId}
                    onCancel={this.onCancelExportMetaEdit}
                    onConfirm={this.onConfirmExportMetaEdit} />
                ) : undefined }
              </>
            ) : undefined }
          </>
        ) : undefined }
      </LangContext.Provider>
    );
  }

  private onOrderChange = (event: GameOrderChangeEvent): void => {
    updatePreferencesData({
      gamesOrderBy: event.orderBy,
      gamesOrder: event.orderReverse,
    });
  }

  private onToggleLeftSidebarClick = (): void => {
    updatePreferencesData({ browsePageShowLeftSidebar: !this.props.preferencesData.browsePageShowLeftSidebar });
  }

  private onToggleRightSidebarClick = (): void => {
    updatePreferencesData({ browsePageShowRightSidebar: !this.props.preferencesData.browsePageShowRightSidebar });
  }

  private onSelectGame = (gameId?: string): void => {
    const library = getBrowseSubPath(this.props.location.pathname);
    const view = this.props.main.views[library];
    if (view) {
      this.props.dispatchMain({
        type: MainActionType.SET_VIEW_SELECTED_GAME,
        library: library,
        gameId: gameId,
      });
    }
  }

  /** Set the selected playlist for a single "browse route" */
  private onSelectPlaylist = (library: string, playlistId: string | undefined): void => {
    this.setViewQuery(library, playlistId);
  }

  private onDownloadUpgradeClick = (stage: UpgradeStage, strings: LangContainer) => {
    downloadAndInstallStage(stage, this.setUpgradeStageState, strings);
  }

  private setUpgradeStageState = (id: string, data: Partial<UpgradeStageState>) => {
    const { upgrades } = this.props.main;
    const index = upgrades.findIndex(u => u.id === id);
    if (index !== -1) {
      const newUpgrades = deepCopy(upgrades);
      const newStageState = Object.assign({}, upgrades[index].state, data);
      newUpgrades[index].state = newStageState;
      this.props.dispatchMain({
        type: MainActionType.SET_UPGRADES,
        upgrades: newUpgrades,
      });
    }
  }

  private onPlaylistDelete = (playlist: Playlist) => {
    if (playlist) {
      const index = this.props.main.playlists.findIndex(p => p.id === playlist.id);
      if (index >= 0) {
        const playlists = [ ...this.props.main.playlists ];
        playlists.splice(index, 1);

        const cache: Record<string, string> = { ...this.props.main.playlistIconCache };
        const id = this.props.main.playlists[index].id;
        if (id in cache) { delete cache[id]; }

        this.props.setMainState({
          playlists: playlists,
          playlistIconCache: cache
        });
      }
    }
  }

  private onUpdatePlaylist = (playlist: Playlist) => {
    const state: Partial<Pick<MainState, 'playlistIconCache' | 'playlists' | 'views'>> = {};

    // Update or add playlist
    const index = this.props.main.playlists.findIndex(p => p.id === playlist.id);
    if (index >= 0) {
      state.playlists = [ ...this.props.main.playlists ];
      state.playlists[index] = playlist;
    } else {
      state.playlists = [ ...this.props.main.playlists, playlist ];
    }

    // Remove old icon from cache
    if (playlist.id in this.props.main.playlistIconCache) {
      state.playlistIconCache = { ...this.props.main.playlistIconCache };
      delete state.playlistIconCache[playlist.id];
      URL.revokeObjectURL(this.props.main.playlistIconCache[playlist.id]); // Free blob from memory
    }

    // Cache new icon
    if (playlist.icon !== undefined) {
      cacheIcon(playlist.icon).then(url => {
        this.props.setMainState({
          playlistIconCache: {
            ...this.props.main.playlistIconCache,
            [playlist.id]: url,
          }
        });
      });
    }

    // Clear view caches (that use this playlist)
    for (const library in this.props.main.views) {
      const view = this.props.main.views[library];
      if (view && (view.query.filter.playlistId === playlist.id)) {
        this.setViewQuery(library);
      }
    }

    this.props.setMainState(state as any); // (This is very annoying to make typesafe)
  }

  onSaveGame = (game: Game, playlistEntry?: PlaylistGame): void => {
    window.Shared.back.sendP<any, SaveGameData>(BackIn.SAVE_GAME, game)
    .then(async () => {
      if (playlistEntry) {
        await window.Shared.back.sendP<unknown, SavePlaylistGameData>(BackIn.SAVE_PLAYLIST_GAME, playlistEntry);
      }
    })
    .then(() => { this.setViewQuery(game.library); });
  }

  onDeleteGame = (gameId: string): void => {
    const library = getBrowseSubPath(this.props.location.pathname);
    window.Shared.back.sendP<unknown, DeleteGameData>(BackIn.DELETE_GAME, { id: gameId })
    .then(() => { this.setViewQuery(library); });
  }

  onLaunchGame(gameId: string): void {
    window.Shared.back.send<LaunchGameData>(BackIn.LAUNCH_GAME, { id: gameId });
  }

  onQuickSearch = (search: string): void => {
    // @TODO
  }

  cachePlaylistIcons(playlists: Playlist[]): void {
    Promise.all(playlists.map(p => (async () => {
      if (p.icon) { return cacheIcon(p.icon); }
    })()))
    .then(urls => {
      const cache: Record<string, string> = {};
      for (let i = 0; i < playlists.length; i++) {
        const url = urls[i];
        if (url) { cache[playlists[i].id] = url; }
      }
      this.props.setMainState({ playlistIconCache: cache });
    });
  }

  filterAndOrderPlaylistsMemo = memoizeOne((playlists: Playlist[], library: string) => {
    // @FIXTHIS "arcade" should not be hard coded as the "default" library
    const lowerLibrary = library.toLowerCase();
    return (
      playlists
      .filter(p => p.library ? p.library.toLowerCase() === lowerLibrary : (lowerLibrary === '' || lowerLibrary === 'arcade'))
      .sort((a, b) => {
        if (a.title < b.title) { return -1; }
        if (a.title > b.title) { return  1; }
        return 0;
      })
    );
  });

  private unmountBeforeClose = (): void => {
    this.props.dispatchMain({ type: MainActionType.STOP_RENDER });
    setTimeout(() => { window.close(); }, 100);
  }

  /** Convert the platforms object into a flat array of platform names (with all duplicates removed). */
  private flattenPlatformsMemo = memoizeOne((platforms: Record<string, string[]>): string[] => {
    const names: string[] = [];
    const libraries = Object.keys(platforms);
    for (let i = 0; i < libraries.length; i++) {
      const p = platforms[libraries[i]];
      for (let j = 0; j < p.length; j++) {
        if (names.indexOf(p[j]) === -1) { names.push(p[j]); }
      }
    }
    return names;
  });

  /**
   * Set the query of a view.
   * Note: If there is only one argument (counted by length) then the playlistId will remain the same.
   */
  setViewQuery = (function(this: App, library: string = getBrowseSubPath(this.props.location.pathname), playlistId?: string): void {
    this.props.dispatchMain({
      type: MainActionType.SET_VIEW_QUERY,
      library: library,
      searchText: this.props.search.text,
      showExtreme: this.props.preferencesData.browsePageShowExtreme,
      orderBy: this.props.preferencesData.gamesOrderBy,
      orderReverse: this.props.preferencesData.gamesOrder,
      playlistId: (arguments.length >= 2)
        ? playlistId
        : null,
    });
  }).bind(this);

  updateView: UpdateView = (start, count) => {
    this.props.dispatchMain({
      type: MainActionType.SET_VIEW_BOUNDRIES,
      library: getBrowseSubPath(this.props.location.pathname),
      start: start,
      count: count,
    });
  }

  onOpenExportMetaEdit = (gameId: string): void => {
    this.props.dispatchMain({
      type: MainActionType.OPEN_META_EXPORTER,
      gameId: gameId,
    });
  }

  onCancelExportMetaEdit = (): void => {
    this.props.dispatchMain({ type: MainActionType.CLOSE_META_EXPORTER });
  }

  onConfirmExportMetaEdit = (data: MetaEditExporterConfirmData): void => {
    this.props.dispatchMain({ type: MainActionType.CLOSE_META_EXPORTER });
    window.Shared.back.sendP<any, ExportMetaEditData>(BackIn.EXPORT_META_EDIT, {
      id: data.id,
      properties: data.properties,
    });
  }

  rollRandomGames = (first?: boolean) => {
    const { randomGames, requestingRandomGames } = this.props.main;

    // Shift in new games from the queue
    if (first !== true) {
      this.props.dispatchMain({ type: MainActionType.SHIFT_RANDOM_GAMES });
    }

    // Request more games to the queue
    if (randomGames.length <= 15 && !requestingRandomGames) {
      this.props.dispatchMain({ type: MainActionType.REQUEST_RANDOM_GAMES });

      window.Shared.back.send<RandomGamesResponseData, RandomGamesData>(BackIn.RANDOM_GAMES, {
        count: 50,
        broken: window.Shared.config.data.showBrokenGames,
        extreme: this.props.preferencesData.browsePageShowExtreme,
        excludedLibraries: this.props.preferencesData.excludedRandomLibraries,
      }, (res) => {
        this.props.dispatchMain({
          type: MainActionType.RESPONSE_RANDOM_GAMES,
          games: res.data || [],
        });
      });
    }
  };
}

async function downloadAndInstallStage(stage: UpgradeStage, setStageState: (id: string, stage: Partial<UpgradeStageState>) => void, strings: LangContainer) {
  // Check data folder is set
  let flashpointPath = window.Shared.config.data.flashpointPath;
  const isValid = await isFlashpointValidCheck(flashpointPath);
  if (!isValid) {
    let verifiedPath = false;
    let chosenPath: (string | undefined);
    while (verifiedPath !== true) {
      // If folder isn't set, ask to set now
      const res = await openConfirmDialog(strings.dialog.flashpointPathInvalid, strings.dialog.flashpointPathNotFound);
      if (!res) { return; }
      // Set folder now
      const chosenPaths = window.Shared.showOpenDialogSync({
        title: strings.dialog.selectFolder,
        properties: ['openDirectory', 'promptToCreate', 'createDirectory']
      });
      if (chosenPaths && chosenPaths.length > 0) {
        // Take first selected folder (Should only be able to select 1 anyway!)
        chosenPath = chosenPaths[0];
        // Make sure we can write to this path
        const havePerms = await canReadWrite(chosenPath);
        if (!havePerms) {
          remote.dialog.showMessageBoxSync({
            title: strings.dialog.badFolderPerms,
            type: 'error',
            message: strings.dialog.pickAnotherFolder
          });
        } else {
          // Verify the path chosen is the one desired
          const topString = formatString(strings.dialog.upgradeWillInstallTo, getUpgradeString(stage.title, strings.upgrades));
          const choiceVerify = await openConfirmDialog(strings.dialog.areYouSure, `${topString}:\n\n${chosenPath}\n\n${strings.dialog.verifyPathSelection}`);
          if (choiceVerify) {
            verifiedPath = true;
          }
        }
      } else {
        // Window closed, cancel the upgrade
        return;
      }
    }
    // Make sure folder given exists
    if (chosenPath) {
      flashpointPath = chosenPath;
      fs.ensureDirSync(flashpointPath);
      // Save picked folder to config
      window.Shared.back.send<any, UpdateConfigData>(BackIn.UPDATE_CONFIG, {
        flashpointPath: flashpointPath,
      }, () => { /* window.Shared.restart(); */ });
    }
  }
  // Flag as installing
  setStageState(stage.id, {
    isInstalling: true,
    installProgressNote: '...',
  });
  // Grab filename from url

  for (const source of stage.sources) {
    const filename = stage.id + '__' + source.split('/').pop() || 'unknown';
    let lastUpdateType = '';
    // Start download and installation
    let prevProgressUpdate = Date.now();
    const state = downloadAndInstallUpgrade(stage, {
      installPath: path.join(flashpointPath),
      downloadFilename: filename
    })
    .on('progress', () => {
      const now = Date.now();
      if (now - prevProgressUpdate > 100 || lastUpdateType !== state.currentTask) {
        prevProgressUpdate = now;
        lastUpdateType = state.currentTask;
        switch (state.currentTask) {
          case 'downloading': setStageState(stage.id, { installProgressNote: `${strings.misc.downloading}: ${(state.downloadProgress * 100).toFixed(1)}%` }); break;
          case 'extracting':  setStageState(stage.id, { installProgressNote: `${strings.misc.extracting}: ${(state.extractProgress * 100).toFixed(1)}%` });   break;
          case 'installing':  setStageState(stage.id, { installProgressNote: `${strings.misc.installingFiles}`});                                         break;
          default:            setStageState(stage.id, { installProgressNote: '...' });                                                        break;
        }
      }
    })
    .once('done', async () => {
      // Flag as done installing
      setStageState(stage.id, {
        isInstalling: false,
        isInstallationComplete: true,
      });
      const res = await openConfirmDialog(strings.dialog.restartNow, strings.dialog.restartToApplyUpgrade);
      if (res) {
        window.Shared.restart();
      }
    })
    .once('error', (error) => {
      // Flag as not installing (so the user can retry if they want to)
      setStageState(stage.id, {
        isInstalling: false,
      });
      log.error('Launcher', `Error installing '${stage.title}' - ${error.message}`);
      console.error(error);
    })
    .on('warn', console.warn);
  }
}

async function cacheIcon(icon: string): Promise<string> {
  const r = await fetch(icon);
  const blob = await r.blob();
  return `url(${URL.createObjectURL(blob)})`;
}

function onUpdateDownloaded() {
  remote.dialog.showMessageBox({
    title: 'Installing Update',
    message: 'The Launcher will restart to install the update now.',
    buttons: ['OK']
  })
  .then(() => {
    setImmediate(() => autoUpdater.quitAndInstall());
  });
}

function isInitDone(state: MainState): boolean {
  return (
    state.gamesDoneLoading &&
    state.upgradesDoneLoading &&
    state.creditsDoneLoading &&
    state.loaded[BackInit.EXEC]
  );
}
