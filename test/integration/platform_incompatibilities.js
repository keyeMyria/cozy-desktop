/* @flow */

import {
  after,
  afterEach,
  before,
  beforeEach,
  suite,
  test
} from 'mocha'
import should from 'should'

import Builders from '../builders'
import configHelpers from '../helpers/config'
import * as cozyHelpers from '../helpers/cozy'
import pouchHelpers from '../helpers/pouch'
import { IntegrationTestHelpers } from '../helpers/integration'

suite('Platform incompatibilities', () => {
  let builders, cozy, helpers

  before(configHelpers.createConfig)
  before(configHelpers.registerClient)
  beforeEach(pouchHelpers.createDatabase)
  beforeEach(cozyHelpers.deleteAll)

  afterEach(() => helpers.local.clean())
  afterEach(pouchHelpers.cleanDatabase)
  after(configHelpers.cleanConfig)

  beforeEach(async function () {
    cozy = cozyHelpers.cozy
    builders = new Builders(cozy, this.pouch)
    helpers = new IntegrationTestHelpers(this.config, this.pouch, cozy)

    await helpers.local.setupTrash()
    await helpers.remote.ignorePreviousChanges()
  })

  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    test.skip(`is not tested on ${process.platform}`, () => {})
  } else {
    test('fixed directory content is synced', async () => {
      const dir = await builders.remote.dir().named('foo:bar').create()
      await builders.remote.dir().inDir(dir).named('empty-subdir').create()
      const subdir = await builders.remote.dir().inDir(dir).named('subdir').create()
      await builders.remote.file().inDir(subdir).named('file').create()

      await helpers.remote.pullChanges()
      await helpers.syncAll()
      should(await helpers.local.tree()).be.empty()

      await cozy.files.updateAttributesById(dir._id, {name: 'foo-bar'})
      await helpers.remote.pullChanges()
      await helpers.syncAll()
      should(await helpers.local.tree()).deepEqual([
        'foo-bar/',
        'foo-bar/empty-subdir/',
        'foo-bar/subdir/',
        'foo-bar/subdir/file'
      ])
    })
  }
})
