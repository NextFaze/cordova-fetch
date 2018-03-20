/**
 Licensed to the Apache Software Foundation (ASF) under one
 or more contributor license agreements.  See the NOTICE file
 distributed with this work for additional information
 regarding copyright ownership.  The ASF licenses this file
 to you under the Apache License, Version 2.0 (the
 'License'); you may not use this file except in compliance
 with the License.  You may obtain a copy of the License at
 http://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing,
 software distributed under the License is distributed on an
 'AS IS' BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 KIND, either express or implied.  See the License for the
 specific language governing permissions and limitations
 under the License.
 */

var Q = require('q');
var shell = require('shelljs');
var superspawn = require('cordova-common').superspawn;
var events = require('cordova-common').events;
var url = require('url');
var path = require('path');
var fs = require('fs');
var CordovaError = require('cordova-common').CordovaError;
var isUrl = require('is-url');
var isGitUrl = require('is-git-url');
var hostedGitInfo = require('hosted-git-info');

/*
 * A function that npm installs a module from npm or a git url
 *
 * @param {String} target   the packageID or git url
 * @param {String} dest     destination of where to install the module
 * @param {Object} opts     [opts={save:true}] options to pass to fetch module
 *
 * @return {String|Promise}    Returns string of the absolute path to the installed module.
 *
 */
module.exports = function (target, dest, opts) {
    var fetchArgs = opts.link ? ['link'] : ['install'];
    opts = opts || {};
    var nodeModulesDir = dest;

    if (dest && target) {

        // add target to fetchArgs Array
        fetchArgs.push(target);

        // append node_modules to nodeModulesDir if it doesn't come included
        if (path.basename(dest) !== 'node_modules') {
            nodeModulesDir = path.resolve(path.join(dest, 'node_modules'));
        }
        // create node_modules if it doesn't exist
        if (!fs.existsSync(nodeModulesDir)) {
            shell.mkdir('-p', nodeModulesDir);
        }
    } else return Q.reject(new CordovaError('Need to supply a target and destination'));

    opts.cwd = dest;
    // Skip dependencye tree checking and install

    var id = trimID(target);
    events.emit('verbose', 'plugin ' + id + ' prepare');
    return Q.resolve(module.exports.getPath(id, nodeModulesDir, target));
};

/*
 * Takes the specified target and returns the moduleID
 * If the git repoName is different than moduleID, then the
 * output from this function will be incorrect. This is the
 * backup way to get ID. getJsonDiff is the preferred way to
 * get the moduleID of the installed module.
 *
 * @param {String} target    target that was passed into cordova-fetch.
 *                           can be moduleID, moduleID@version, gitURL or relative path (file:relative/path)
 *
 * @return {String} ID       moduleID without version.
 */
function trimID (target) {
    var parts;
    // If GITURL, set target to repo name
    var gitInfo = hostedGitInfo.fromUrl(target);
    if (gitInfo) {
        target = gitInfo.project;
    } else if (isUrl(target) || isGitUrl(target)) {
        // strip away .git and everything that follows
        var strippedTarget = target.split('.git');
        var re = /.*\/(.*)/;
        // Grabs everything in url after last `/`
        parts = strippedTarget[0].match(re);

        target = parts[1];
    }

    // If local path exists, try to get plugin id from package.json or set target to final directory
    if (target.startsWith('file:')) {
        // If target starts with file: prefix, strip it
        target = target.substring(5);
    }

    if (fs.existsSync(target)) {
        var pluginId;
        var pkgJsonPath = path.join(target, 'package.json');

        if (fs.existsSync(pkgJsonPath)) {
            pluginId = JSON.parse(fs.readFileSync(pkgJsonPath)).name;
        }

        target = pluginId || path.basename(target);
    }

    // strip away everything after '@'
    // also support scoped packages
    if (target.indexOf('@') !== -1) {
        parts = target.split('@');
        if (parts.length > 1 && parts[0] === '') {
            // scoped package
            target = '@' + parts[1];
        } else {
            target = parts[0];
        }
    }

    return target;
}

/*
 * Takes the moduleID and destination and returns an absolute path to the module
 *
 * @param {String} id       the packageID
 * @param {String} dest     destination of where to fetch the modules
 *
 * @return {String|Error}  Returns the absolute url for the module or throws a error
 *
 */

function getPath (id, dest, target) {
    var destination = path.resolve(path.join(dest, id));
    var finalDest = fs.existsSync(destination) ? destination : searchDirForTarget(dest, target);

    if (!finalDest) {
        throw new CordovaError('Failed to get absolute path to installed module');
    }

    return finalDest;
}

module.exports.getPath = getPath;
/*
 * Make an additional search in destination folder using repository.url property from package.json
 *
 * @param {String} dest     destination of where to fetch the modules
 * @param {String} target   target that was passed into cordova-fetch. can be moduleID, moduleID@version or gitURL
 *
 * @return {String}         Returns the absolute url for the module or null
 *
 */

function searchDirForTarget (dest, target) {
    if (!isUrl(target)) {
        return;
    }

    var targetPathname = url.parse(target).pathname;

    var pkgJsonPath = fs.readdirSync(dest).map(function (dir) {
        return path.join(dest, dir, 'package.json');
    })
        .filter(fs.existsSync)
        .find(function (pkgJsonPath) {
            var repo = JSON.parse(fs.readFileSync(pkgJsonPath)).repository;
            return repo && url.parse(repo.url).pathname === targetPathname;
        });

    return pkgJsonPath && path.dirname(pkgJsonPath);
}

/*
 * Checks to see if npm is installed on the users system
 * @return {Promise|Error} Returns true or a cordova error.
 */

function isNpmInstalled () {
    if (!shell.which('npm')) {
        return Q.reject(new CordovaError('"npm" command line tool is not installed: make sure it is accessible on your PATH.'));
    }
    return Q();
}

module.exports.isNpmInstalled = isNpmInstalled;
/*
 * A function that deletes the target from node_modules and runs npm uninstall
 *
 * @param {String} target   the packageID
 * @param {String} dest     destination of where to uninstall the module from
 * @param {Object} opts     [opts={save:true}] options to pass to npm uninstall
 *
 * @return {Promise|Error}    Returns a promise with the npm uninstall output or an error.
 *
 */
module.exports.uninstall = function (target, dest, opts) {
    var fetchArgs = ['uninstall'];
    opts = opts || {};

    // check if npm is installed on the system
    return isNpmInstalled()
        .then(function () {
            if (dest && target) {
                // add target to fetchArgs Array
                fetchArgs.push(target);
            } else return Q.reject(new CordovaError('Need to supply a target and destination'));

            // set the directory where npm uninstall will be run
            opts.cwd = dest;

            // if user added --save flag, pass it to npm uninstall command
            if (opts.save) {
                fetchArgs.push('--save');
            } else {
                fetchArgs.push('--no-save');
            }

            // run npm uninstall, this will remove dependency
            // from package.json if --save was used.
            return superspawn.spawn('npm', fetchArgs, opts);
        })
        .then(function (res) {
            var pluginDest = path.join(dest, 'node_modules', target);
            if (fs.existsSync(pluginDest)) {
                shell.rm('-rf', pluginDest);
            }
            return res;
        })
        .fail(function (err) {
            return Q.reject(new CordovaError(err));
        });
};
