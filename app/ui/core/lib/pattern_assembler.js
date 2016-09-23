"use strict";

var path = require('path'),
  fs = require('fs-extra'),
  Pattern = require('./object_factory').Pattern,
  pph = require('./pseudopattern_hunter'),
  mp = require('./markdown_parser'),
  plutils = require('./utilities'),
  patternEngines = require('./pattern_engines'),
  lh = require('./lineage_hunter'),
  lih = require('./list_item_hunter'),
  ph = require('./partial_hunter'),
  JSON5 = require('json5');

var markdown_parser = new mp();

var pattern_assembler = function () {
  // HELPER FUNCTIONS

  function getPartial(partialName, patternlab) {
    //look for exact partial matches
    for (var i = 0; i < patternlab.patterns.length; i++) {
      var pattern = patternlab.patterns[i];

      if (pattern.patternPartial === partialName) {
        return pattern;

      //also check for Pattern Lab PHP syntax for hidden patterns
      //Pattern Lab PHP strips leading underscores from pattern filenames,
      //strips leading digits plus hyphen,
      //and retains the first tilde instead of replacing it with a hyphen
      } else if (partialName === pattern.patternGroup + '-' + pattern.fileName.replace(/^_/, '').replace(/^\d*\-/, '')) {
        return pattern;
      }
    }

    //else look by verbose syntax
    for (var i = 0; i < patternlab.patterns.length; i++) {
      switch (partialName) {
        case patternlab.patterns[i].relPath:
        case patternlab.patterns[i].subdir + '/' + patternlab.patterns[i].fileName:
          return patternlab.patterns[i];
      }
    }

    //return the fuzzy match if all else fails
    for (var i = 0; i < patternlab.patterns.length; i++) {
      var partialParts = partialName.split('-'),
        partialType = partialParts[0],
        partialNameEnd = partialParts.slice(1).join('-');

      if (patternlab.patterns[i].patternPartial.split('-')[0] === partialType && patternlab.patterns[i].patternPartial.indexOf(partialNameEnd) > -1) {
        return patternlab.patterns[i];
      }
    }
    console.error('Could not find pattern with partial ' + partialName);
    return undefined;
  }

  function buildListItems(container) {
    //combine all list items into one structure
    var list = [];
    for (var item in container.listitems) {
      if (container.listitems.hasOwnProperty(item)) {
        list.push(container.listitems[item]);
      }
    }
    container.listItemArray = plutils.shuffle(list);

    for (var i = 1; i <= container.listItemArray.length; i++) {
      var tempItems = [];
      if (i === 1) {
        tempItems.push(container.listItemArray[0]);
        container.listitems['' + i ] = tempItems;
      } else {
        for (var c = 1; c <= i; c++) {
          tempItems.push(container.listItemArray[c - 1]);
          container.listitems['' + i ] = tempItems;
        }
      }
    }
  }

  /*
   * Deprecated in favor of .md 'status' frontmatter inside a pattern. Still used for unit tests at this time.
   * Will be removed in future versions
   */
  function setState(pattern, patternlab, displayDeprecatedWarning) {
    if (patternlab.config.patternStates && patternlab.config.patternStates[pattern.patternPartial]) {

      if (displayDeprecatedWarning) {
        plutils.logRed("Deprecation Warning: Using patternlab-config.json patternStates object will be deprecated in favor of the state frontmatter key associated with individual pattern markdown files.");
        console.log("This feature will still work in it's current form this release (but still be overridden by the new parsing method), and will be removed in the future.");
      }

      pattern.patternState = patternlab.config.patternStates[pattern.patternPartial];
    }
  }

  function addPattern(pattern, patternlab) {

    //add the link to the global object
    patternlab.data.link[pattern.patternPartial] = '/patterns/' + pattern.patternLink;

    //only push to array if the array doesn't contain this pattern
    var isNew = true;
    for (var i = 0; i < patternlab.patterns.length; i++) {
      //so we need the identifier to be unique, which patterns[i].relPath is
      if (pattern.relPath === patternlab.patterns[i].relPath) {
        //if relPath already exists, overwrite that element
        patternlab.patterns[i] = pattern;
        isNew = false;
        break;
      }
    }

    // if the pattern is new, we must register it with various data structures!
    if (isNew) {

      if (patternlab.config.debug) {
        console.log('found new pattern ' + pattern.patternPartial);
      }

      // do global registration


      if (pattern.isPattern) {
        // do plugin-specific registration
        pattern.registerPartial(patternlab);
      }

      patternlab.patterns.push(pattern);

    }
  }

  function addSubtypePattern(subtypePattern, patternlab) {
    patternlab.subtypePatterns[subtypePattern.patternPartial] = subtypePattern;
  }

  // Render a pattern on request. Long-term, this should probably go away.
  function renderPattern(pattern, data, partials) {
    // if we've been passed a full Pattern, it knows what kind of template it
    // is, and how to render itself, so we just call its render method
    if (pattern instanceof Pattern) {
      return pattern.render(data, partials);
    } else {
      // otherwise, check for the first loaded templating engine, and we
      // therefore just need to create a dummy pattern to be able to render
      // it
      var dummyPattern = Pattern.createEmpty({extendedTemplate: pattern});
      var engine;
      var engineName = Object.keys(patternEngines)[0];
      if (engineName) {
        engine = patternEngines[engineName];
      }
      if (engine) {
        return engine.renderPattern(dummyPattern, data, partials);
      } else {
        return pattern;
      }
    }
  }

  function parsePatternMarkdown(currentPattern, patternlab) {

    try {
      var markdownFileName = path.resolve(patternlab.config.paths.source.patterns, currentPattern.subdir, currentPattern.fileName + ".md");
      var markdownFileContents = fs.readFileSync(markdownFileName, 'utf8');

      var markdownObject = markdown_parser.parse(markdownFileContents);
      if (!plutils.isObjectEmpty(markdownObject)) {
        //set keys and markdown itself
        currentPattern.patternDescExists = true;
        currentPattern.patternDesc = markdownObject.markdown;

        //consider looping through all keys eventually. would need to blacklist some properties and whitelist others
        if (markdownObject.state) {
          currentPattern.patternState = markdownObject.state;
        }
        if (markdownObject.order) {
          currentPattern.order = markdownObject.order;
        }
        if (markdownObject.hidden) {
          currentPattern.hidden = markdownObject.hidden;
        }
        if (markdownObject.excludeFromStyleguide) {
          currentPattern.excludeFromStyleguide = markdownObject.excludeFromStyleguide;
        }
        if (markdownObject.tags) {
          currentPattern.tags = markdownObject.tags;
        }
        if (markdownObject.links) {
          currentPattern.links = markdownObject.links;
        }
      } else {
        if (patternlab.config.debug) {
          console.log('error processing markdown for ' + currentPattern.patternPartial);
        }
      }

      if (patternlab.config.debug) {
        console.log('found pattern-specific markdown for ' + currentPattern.patternPartial);
      }
    }
    catch (err) {
      // do nothing when file not found
      if (err.code !== 'ENOENT') {
        console.log('there was an error setting pattern keys after markdown parsing of the companion file for pattern ' + currentPattern.patternPartial);
        console.log(err);
      }
    }
  }

  /**
   * Recursively get all the property keys from the JSON data for a pattern.
   *
   * @param {object} data
   * @param {array} uniqueKeysParam The array of unique keys to be added to and returned.
   * @returns {array} keys A flat, one-dimensional array.
   */
  function getDataKeys(data, uniqueKeysParam) {
    var uniqueKeys = uniqueKeysParam || [];

    for (var key in data) {
      if (data.hasOwnProperty(key)) {
        if (data.constructor !== Array) {
          if (uniqueKeys.indexOf(key) === -1) {
            uniqueKeys.push(key);
          } else {
            continue;
          }
        }
        if (typeof data[key] === 'object') {
          getDataKeys(data[key], uniqueKeys);
        }
      }
    }

    return uniqueKeys;
  }

  function processPatternIterative(relPath, patternlab) {
    var list_item_hunter = new lih();

    //check if the found file is a top-level markdown file
    var fileObject = path.parse(relPath);
    if (fileObject.ext === '.md') {
      try {
        var proposedDirectory = path.resolve(patternlab.config.paths.source.patterns, fileObject.dir, fileObject.name);
        var proposedDirectoryStats = fs.statSync(proposedDirectory);
        if (proposedDirectoryStats.isDirectory()) {
          var subTypeMarkdownFileContents = fs.readFileSync(proposedDirectory + '.md', 'utf8');
          var subTypeMarkdown = markdown_parser.parse(subTypeMarkdownFileContents);
          var subTypePattern = new Pattern(relPath);
          subTypePattern.patternSectionSubtype = true;
          subTypePattern.patternLink = subTypePattern.name + '/index.html';
          subTypePattern.patternDesc = subTypeMarkdown.markdown;
          subTypePattern.patternPartial = 'viewall-' + subTypePattern.patternPartial;
          subTypePattern.isPattern = false;
          subTypePattern.engine = null;

          addSubtypePattern(subTypePattern, patternlab);
          return subTypePattern;
        }
      } catch (err) {
        // no file exists, meaning it's a pattern markdown file
        if (err.code !== 'ENOENT') {
          console.log(err);
        }
      }

    }

    //extract some information
    var filename = fileObject.base;
    var ext = fileObject.ext;
    var patternsPath = patternlab.config.paths.source.patterns;

    // skip non-pattern files
    if (!patternEngines.isPatternFile(filename, patternlab)) { return null; }

    //make a new Pattern Object
    var currentPattern = new Pattern(relPath);

    //if file is named in the syntax for variants
    if (patternEngines.isPseudoPatternJSON(filename)) {
      addPattern(currentPattern, patternlab);
      return currentPattern;
    }

    //can ignore all non-supported files at this point
    if (patternEngines.isFileExtensionSupported(ext) === false) {
      return currentPattern;
    }

    //see if this file has a state
    setState(currentPattern, patternlab, true);

    //look for a json file for this template
    var jsonFilename = '';
    var jsonFilenameStats;
    var jsonFileStr = '';
    try {
      var jsonFilename = path.resolve(patternsPath, currentPattern.subdir, currentPattern.fileName + '.json');
      var jsonFilenameStats = fs.statSync(jsonFilename);
    } catch (err) {
      //not a file
    }

    if (jsonFilenameStats && jsonFilenameStats.isFile()) {
      try {
        jsonFileStr = fs.readFileSync(jsonFilename, 'utf8');
        currentPattern.jsonFileData = JSON5.parse(jsonFileStr);
        if (patternlab.config.debug) {
          console.log('processPatternIterative: found pattern-specific data.json for ' + currentPattern.patternPartial);
        }
      } catch (err) {
        console.log('There was an error parsing sibling JSON for ' + currentPattern.relPath);
        console.log(err);
      }
    }

    //add allData keys to currentPattern.dataKeys
    currentPattern.dataKeys = getDataKeys(currentPattern.jsonFileData);

    //look for a listitems.json file for this template
    try {
      var listJsonFileName = path.resolve(patternsPath, currentPattern.subdir, currentPattern.fileName + ".listitems.json");
      try {
        var listJsonFileStats = fs.statSync(listJsonFileName);
      } catch (err) {
        //not a file
      }
      if (listJsonFileStats && listJsonFileStats.isFile()) {
        currentPattern.listitems = fs.readJSONSync(listJsonFileName);
        buildListItems(currentPattern);
        if (patternlab.config.debug) {
          console.log('found pattern-specific listitems.json for ' + currentPattern.patternPartial);
        }
      }
    }
    catch (err) {
      console.log('There was an error parsing sibling listitem JSON for ' + currentPattern.relPath);
      console.log(err);
    }

    //look for a markdown file for this template
    parsePatternMarkdown(currentPattern, patternlab);

    //add the raw template to memory
    currentPattern.template = fs.readFileSync(path.resolve(patternsPath, relPath), 'utf8');
    currentPattern.extendedTemplate = currentPattern.template;

    //find any listItem blocks within the pattern
    list_item_hunter.process_list_item_partials(currentPattern, patternlab);

    //find any stylemodifiers that may be in the current pattern
    currentPattern.stylePartials = currentPattern.findPartialsWithStyleModifiers();

    //add currentPattern to patternlab.patterns array
    addPattern(currentPattern, patternlab);

    return currentPattern;
  }

  function processPatternRecursive(relPath, patternlab, origPatternParam, levelParam) {
    var lineage_hunter = new lh();
    var pseudopattern_hunter = new pph();
    var currentPattern;
    var i;

    //find current pattern in patternlab object either as passed as a param
    //or by identifying by relPath
    if (origPatternParam) {
      currentPattern = origPatternParam;

    } else {
      for (i = 0; i < patternlab.patterns.length; i++) {
        if (patternlab.patterns[i].relPath === relPath) {
          currentPattern = patternlab.patterns[i];
        }
      }
    }

    //return if processing an ignored file
    if (typeof currentPattern === 'undefined') { return; }

    //we are processing a markdown only pattern
    if (currentPattern.engine === null) { return; }

    //merge global data into local data after iterating through all patterns
    //but not after first recursion
    if (!currentPattern.allData) {
      currentPattern.allData = plutils.mergeData(patternlab.data, currentPattern.jsonFileData);
    }

    var level;
    if (typeof levelParam === 'undefined') {
      //only do the following at the top level of recursion
      //check if this is a pseudopattern by checking if this is a file containing same name, with ~ in it, ending in .json
      //if so, return
      if (patternEngines.isPseudoPatternJSON(currentPattern.relPath)) {
        return;

      //else look for a pseudopattern variants of this pattern
      } else {
        pseudopattern_hunter.find_pseudopatterns(currentPattern, patternlab);
      }
      level = 1;

    } else {
      level++;
    }

    //find how many partials there may be for the given pattern
    currentPattern.patternPartials = currentPattern.findPartials();

    //expand any partials present in this pattern; that is, drill down into the
    //template and replace their calls in this template with rendered results
    if (currentPattern.engine.expandPartials && (currentPattern.patternPartials !== null && currentPattern.patternPartials.length > 0)) {
      //find pattern lineage
      lineage_hunter.find_lineage(currentPattern, patternlab);

      // eslint-disable-next-line
      expandPartials(patternlab, currentPattern, level);
    }
  }

  function expandPartials(patternlab, currentPattern, level) {

    var partial_hunter = new ph();
    var list_item_hunter = new lih();

    if (patternlab.config.debug) {
      console.log('found partials for ' + currentPattern.patternPartial);
    }

    partial_hunter.replace_partials(currentPattern, patternlab);

    //find any listItem blocks within the pattern
    list_item_hunter.process_list_item_partials(currentPattern, patternlab);

    processPatternRecursive(currentPattern.relPath, patternlab, currentPattern, level);
  }

  function parseDataLinksHelper(patternlab, obj, key) {
    var linkRE, dataObjAsString, linkMatches, expandedLink;

    linkRE = /link\.[A-z0-9-_]+/g;
    dataObjAsString = JSON5.stringify(obj);
    linkMatches = dataObjAsString.match(linkRE);

    if (linkMatches) {
      for (var i = 0; i < linkMatches.length; i++) {
        expandedLink = patternlab.data.link[linkMatches[i].split('.')[1]];
        if (expandedLink) {
          if (patternlab.config.debug) {
            console.log('expanded data link from ' + linkMatches[i] + ' to ' + expandedLink + ' inside ' + key);
          }
          dataObjAsString = dataObjAsString.replace(linkMatches[i], expandedLink);
        }
      }
    }

    var dataObj;
    try {
      dataObj = JSON5.parse(dataObjAsString);
    } catch (err) {
      console.log('There was an error parsing JSON for ' + key);
      console.log(err);
    }

    return dataObj;
  }

  //look for pattern links included in data files.
  //these will be in the form of link.* WITHOUT {{}}, which would still be there from direct pattern inclusion
  function parseDataLinks(patternlab) {
    //look for link.* such as link.pages-blog as a value

    patternlab.data = parseDataLinksHelper(patternlab, patternlab.data, 'data.json');

    //loop through all patterns
    for (var i = 0; i < patternlab.patterns.length; i++) {
      patternlab.patterns[i].jsonFileData = parseDataLinksHelper(patternlab, patternlab.patterns[i].jsonFileData, patternlab.patterns[i].partial);
    }
  }

  return {
    find_pattern_partials: function (pattern) {
      return pattern.findPartials();
    },
    find_pattern_partials_with_style_modifiers: function (pattern) {
      return pattern.findPartialsWithStyleModifiers();
    },
    find_pattern_partials_with_parameters: function (pattern) {
      return pattern.findPartialsWithPatternParameters();
    },
    find_list_items: function (pattern) {
      return pattern.findListItems();
    },
    setPatternState: function (pattern, patternlab, displayDeprecatedWarning) {
      setState(pattern, patternlab, displayDeprecatedWarning);
    },
    addPattern: function (pattern, patternlab) {
      addPattern(pattern, patternlab);
    },
    addSubtypePattern: function (subtypePattern, patternlab) {
      addSubtypePattern(subtypePattern, patternlab);
    },
    renderPattern: function (template, data, partials) {
      return renderPattern(template, data, partials);
    },
    process_pattern_iterative: function (file, patternlab) {
      return processPatternIterative(file, patternlab);
    },
    process_pattern_recursive: function (file, patternlab, additionalData) {
      processPatternRecursive(file, patternlab, additionalData);
    },
    getPartial: function (partial, patternlab) {
      return getPartial(partial, patternlab);
    },
    combine_listItems: function (patternlab) {
      buildListItems(patternlab);
    },
    parse_data_links: function (patternlab) {
      parseDataLinks(patternlab);
    },
    parse_data_links_specific: function (patternlab, data, label) {
      return parseDataLinksHelper(patternlab, data, label)
    },
    parse_pattern_markdown: function (pattern, patternlab) {
      parsePatternMarkdown(pattern, patternlab);
    },
    get_data_keys: function (data, uniqueKeys) {
      return getDataKeys(data, uniqueKeys);
    }
  };

};

module.exports = pattern_assembler;
