/* @flow */

import path from 'path'

import { getInode } from './chokidar_event'
import * as prepAction from './prep_action'
import logger from '../logger'

import type { ContextualizedChokidarFSEvent } from './chokidar_event'
import type {
  PrepAction, PrepAddFile, PrepPutFolder,
  PrepDeleteFile, PrepDeleteFolder, PrepMoveFile, PrepMoveFolder
} from './prep_action'

const log = logger({
  component: 'LocalWatcher'
})
log.chokidar = log.child({
  component: 'Chokidar'
})

export default function sortAndSquash (events: ContextualizedChokidarFSEvent[], pendingActions: PrepAction[])
: PrepAction[] {
  const actions: PrepAction[] = analyseEvents(events, pendingActions)
  sortBeforeSquash(actions)
  squashMoves(actions)
  separatePendingActions(actions, pendingActions)
  finalSort(actions)

  log.debug(`Identified ${actions.length} change(s).`)
  return actions
}

const panic = (context, description) => {
  log.error(context, description)
  throw new Error(description)
}

function analyseEvents (events: ContextualizedChokidarFSEvent[], pendingActions: PrepAction[]): PrepAction[] {
  // OPTIMIZE: new Array(events.length)
  const actions: PrepAction[] = []
  const actionsByInode:Map<number, PrepAction> = new Map()
  const actionsByPath:Map<string, PrepAction> = new Map()
  const getActionByInode = (e) => {
    const ino = getInode(e)
    if (ino) return actionsByInode.get(ino)
    else return null
  }
  const getActionByPath = (e) => {
    return actionsByPath.get(e.path)
  }
  const pushAction = (a: PrepAction) => {
    actionsByPath.set(a.path, a)
    if (a.ino) actionsByInode.set(a.ino, a)
    else actions.push(a)
  }

  if (pendingActions.length > 0) {
    log.warn({actions: pendingActions}, `Prepend ${pendingActions.length} pending action(s)`)
    for (const a of pendingActions) { pushAction(a) }
    pendingActions.length = 0
  }

  log.trace('Analyze events...')

  for (let e: ContextualizedChokidarFSEvent of events) {
    try {
      switch (e.type) {
        case 'add':
          {
            const moveAction: ?PrepMoveFile = prepAction.maybeMoveFile(getActionByInode(e))
            if (moveAction) {
              /* istanbul ignore next */
              if (!moveAction.wip) {
                panic({path: e.path, moveAction, event: e},
                  'We should not have both move and add actions since ' +
                  'checksumless adds and inode-less unlink events are dropped')
              }
              moveAction.path = e.path
              moveAction.stats = e.stats
              moveAction.md5sum = e.md5sum
              delete moveAction.wip
              log.debug(
                {path: e.path, oldpath: moveAction.old.path, ino: moveAction.stats.ino},
                'File move completing')
              break
            }

            const unlinkAction: ?PrepDeleteFile = prepAction.maybeDeleteFile(getActionByInode(e))
            if (unlinkAction) {
              // New move found
              log.debug({oldpath: unlinkAction.path, path: e.path, ino: unlinkAction.ino}, 'File moved')
              pushAction(prepAction.build('PrepMoveFile', e.path, {stats: e.stats, md5sum: e.md5sum, old: unlinkAction.old, ino: unlinkAction.ino, wip: e.wip}))
            } else {
              pushAction(prepAction.fromChokidar(e))
            }
          }
          break
        case 'addDir':
          {
            const moveAction: ?PrepMoveFolder = prepAction.maybeMoveFolder(getActionByInode(e))
            /* istanbul ignore next */
            if (moveAction) {
              if (!moveAction.wip) {
                panic({path: e.path, moveAction, event: e},
                 'We should not have both move and addDir actions since ' +
                 'non-existing addDir and inode-less unlinkDir events are dropped')
              }
              moveAction.path = e.path
              moveAction.stats = e.stats
              delete moveAction.wip
              log.debug(
               {path: e.path, oldpath: moveAction.old.path, ino: moveAction.stats.ino},
               'Folder move completing')
            }

            const unlinkAction: ?PrepDeleteFolder = prepAction.maybeDeleteFolder(getActionByInode(e))
            if (unlinkAction) {
              // New move found
              log.debug({oldpath: unlinkAction.path, path: e.path}, 'moveFolder')
              pushAction(prepAction.build('PrepMoveFolder', e.path, {stats: e.stats, old: unlinkAction.old, ino: unlinkAction.ino, wip: e.wip}))
            } else {
              pushAction(prepAction.fromChokidar(e))
            }
          }
          break
        case 'change':
          pushAction(prepAction.fromChokidar(e))
          break
        case 'unlink':
          {
            const moveAction: ?PrepMoveFile = prepAction.maybeMoveFile(getActionByInode(e))
            /* istanbul ignore next */
            if (moveAction) {
              // TODO: Pending move
              panic({path: e.path, moveAction, event: e},
                'We should not have both move and unlink actions since ' +
                'checksumless adds and inode-less unlink events are dropped')
            }

            const addAction: ?PrepAddFile = prepAction.maybeAddFile(getActionByInode(e))
            if (addAction) {
              // New move found
              // TODO: pending move
              log.debug({oldpath: e.path, path: addAction.path, ino: addAction.ino}, 'File moved')
              pushAction(prepAction.build('PrepMoveFile', addAction.path, {
                stats: addAction.stats,
                md5sum: addAction.md5sum,
                old: e.old,
                ino: addAction.ino,
                wip: addAction.wip
              }))
              break
            } else if (getInode(e)) {
              pushAction(prepAction.fromChokidar(e))
              break
            }
            const action: ?PrepMoveFile = prepAction.maybeMoveFile(getActionByPath(e))
            if (action && action.md5sum == null) { // FIXME: if action && action.wip?
              log.debug({path: action.old.path, ino: action.ino}, 'File was moved then deleted. Deleting origin directly.')
              // $FlowFixMe
              action.type = 'PrepDeleteFile'
              action.path = action.old.path
              delete action.stats
              delete action.wip
            }
            // Otherwise, skip unlink event by multiple moves
          }
          break
        case 'unlinkDir':
          {
            const moveAction: ?PrepMoveFolder = prepAction.maybeMoveFolder(getActionByInode(e))
            /* istanbul ignore next */
            if (moveAction) {
              // TODO: pending move
              panic({path: e.path, moveAction, event: e},
                'We should not have both move and unlinkDir actions since ' +
                'non-existing addDir and inode-less unlinkDir events are dropped')
            }

            const addAction: ?PrepPutFolder = prepAction.maybePutFolder(getActionByInode(e))
            if (addAction) {
              // New move found
              log.debug({oldpath: e.path, path: addAction.path}, 'moveFolder')
              pushAction(prepAction.build('PrepMoveFolder', addAction.path, {
                stats: addAction.stats,
                old: e.old,
                ino: addAction.ino,
                wip: addAction.wip
              }))
            } else if (getInode(e)) {
              pushAction(prepAction.fromChokidar(e))
            } // else skip
          }
          // TODO: move & delete dir
          break
        default:
          throw new TypeError(`Unknown event type: ${e.type}`)
      }
    } catch (err) {
      log.error({err, path: e.path})
      throw err
    }
    if (process.env.DEBUG) log.trace({currentEvent: e, actions})
  }

  log.trace('Flatten actions map...')
  for (let a of actionsByInode.values()) actions.push(a)

  return actions
}

// TODO: Rename according to the sort logic
function sortBeforeSquash (actions: PrepAction[]) {
  log.trace('Sort actions before squash...')
  actions.sort((a, b) => {
    if (a.type === 'PrepMoveFolder' || a.type === 'PrepMoveFile') {
      if (b.type === 'PrepMoveFolder' || b.type === 'PrepMoveFile') {
        if (a.path < b.path) return -1
        else if (a.path > b.path) return 1
        else return 0
      } else return -1
    } else if (b.type === 'PrepMoveFolder' || b.type === 'PrepMoveFile') {
      return 1
    } else {
      return 0
    }
  })
}

function squashMoves (actions: PrepAction[]) {
  log.trace('Squash moves...')

  for (let i = 0; i < actions.length; i++) {
    let a = actions[i]

    if (a.type !== 'PrepMoveFolder' && a.type !== 'PrepMoveFile') break
    for (let j = i + 1; j < actions.length; j++) {
      let b = actions[j]
      if (b.type !== 'PrepMoveFolder' && b.type !== 'PrepMoveFile') break

      // inline of PrepAction.isChildMove
      if (a.type === 'PrepMoveFolder' &&
      b.path.indexOf(a.path + path.sep) === 0 &&
      a.old && b.old &&
      b.old.path.indexOf(a.old.path + path.sep) === 0) {
        log.debug({oldpath: b.old.path, path: b.path}, 'descendant move')
        a.wip = a.wip || b.wip
        if (b.path.substr(a.path.length) === b.old.path.substr(a.old.path.length)) {
          actions.splice(j--, 1)
        } else {
          // move inside move
          b.old.path = b.old.path.replace(a.old.path, a.path)
          b.needRefetch = true
        }
      }
    }
  }
}

function separatePendingActions (actions: PrepAction[], pendingActions: PrepAction[]) {
  log.trace('Reserve actions in progress for next flush...')

  // TODO: Use _.partition()?
  for (let i = actions.length - 1; i >= 0; i--) {
    const action = actions[i]
    if (action.wip) {
      if (action.type === 'PrepMoveFolder' || action.type === 'PrepMoveFile') {
        log.debug({
          action: action.type,
          oldpath: action.old.path,
          path: action.path,
          ino: action.ino
        }, 'incomplete action')
      } else {
        log.debug({action: action.type, path: action.path}, 'incomplete action')
      }
      pendingActions.push(actions[i])
      actions.splice(i, 1)
    }
  }
}

// TODO: Rename according to the sort logic
const finalSorter = (a: PrepAction, b: PrepAction) => {
  if (prepAction.childOf(prepAction.addPath(a), prepAction.delPath(b))) return -1
  if (prepAction.childOf(prepAction.addPath(b), prepAction.delPath(a))) return 1

  // if one action is a child of another, it takes priority
  if (prepAction.isChildAdd(a, b)) return -1
  if (prepAction.isChildDelete(b, a)) return -1
  if (prepAction.isChildAdd(b, a)) return 1
  if (prepAction.isChildDelete(a, b)) return 1

  // otherwise, order by add path
  if (prepAction.lower(prepAction.addPath(a), prepAction.addPath(b))) return -1
  if (prepAction.lower(prepAction.addPath(b), prepAction.addPath(a))) return 1

  // if there isnt 2 add paths, sort by del path
  if (prepAction.lower(prepAction.delPath(b), prepAction.delPath(a))) return -1

  return 1
}

// TODO: Rename according to the sort logic
function finalSort (actions: PrepAction[]) {
  log.trace('Final sort...')
  actions.sort(finalSorter)
}
