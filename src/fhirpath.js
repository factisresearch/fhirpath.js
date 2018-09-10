// This is fhirpath interpreter
// everything starts at evaluate function,
// which is passed  fhirpath AST and resource.
//
// We reduce/eval recursively each node in AST
// passing the context and current data
//
// each AST node has eval function, which should be registered in evalTable
// and named after node type
// if node needs to eval father it's children it has to call `doEval` function
//
// most of nodes do function or operator invocation at the end
//
// For invocation's and operator's there is one lookup table -
// invocationTable and two helper functions doInvoke and infixInvoke for
// operators
// 1. operator or function is looked up in table
// 2. using signature (in  .arity property) unpack parameters
// 3. check params types
// 4. do call function
// 5. wrap result by util.arraify
//
// if function is nullable
// and one of parameters is empty/null - function will not be invoked and empty
// result returned
//
// Not solved problem is overloading functions by types - for example + operator defined
// for strings and numbers
// we can make dispatching params type dependent - let see

const parser = require("./parser");
const util = require("./utilities");

let engine    = {}; // the object with all FHIRPath functions and operations
let existence = require("./existence");
let filtering = require("./filtering");
let combining = require("./combining");
let misc      = require("./misc");
let equality  = require("./equality");
let math      = require("./math");
let strings   = require("./strings");
let navigation= require("./navigation");
let datetime  = require("./datetime");

// * fn: handler
// * arity: is index map with type signature
// * nullable - means propagate empty result, i.e. instead
//   calling function if one of params is  empty return empty

engine.invocationTable = {
  empty:        {fn: existence.emptyFn},
  not:          {fn: existence.notFn},
  exists:       {fn: existence.existsMacro, arity: {0: [], 1: ["Expr"]}},
  all:          {fn: existence.allMacro, arity: {1: ["Expr"]}},
  allTrue:      {fn: existence.allTrueFn},
  anyTrue:      {fn: existence.anyTrueFn},
  allFalse:     {fn: existence.allFalseFn},
  anyFalse:     {fn: existence.anyFalseFn},
  subsetOf:     {fn: existence.subsetOfFn, arity: {1: ["AnyAtRoot"]}},
  supersetOf:   {fn: existence.supersetOfFn, arity: {1: ["AnyAtRoot"]}},
  isDistinct:   {fn: existence.isDistinctFn},
  distinct:     {fn: existence.distinctFn},
  count:        {fn: existence.countFn},
  where:        {fn: filtering.whereMacro, arity: {1: ["Expr"]}},
  select:       {fn: filtering.selectMacro, arity: {1: ["Expr"]}},
  single:       {fn: filtering.singleFn},
  first:        {fn: filtering.firstFn},
  last:         {fn: filtering.lastFn},
  ofType:       {fn: filtering.ofTypeFn, arity: {1: ["Identifier"]}},
  tail:         {fn: filtering.tailFn},
  take:         {fn: filtering.takeFn, arity: {1: ["Integer"]}},
  skip:         {fn: filtering.skipFn, arity: {1: ["Integer"]}},
  combine:      {fn: combining.combineFn, arity: {1: ["AnyAtRoot"]}},
  iif:          {fn: misc.iifMacro,    arity: {3: ["Expr", "Expr", "Expr"]}},
  trace:        {fn: misc.traceFn,     arity: {0: [], 1: ["String"]}},
  toInteger:    {fn: misc.toInteger},
  toDecimal:    {fn: misc.toDecimal},
  toString:     {fn: misc.toString},

  indexOf:        {fn: strings.indexOf,          arity: {1: ["String"]}},
  substring:      {fn: strings.substring,        arity: {1: ["Integer"], 2: ["Integer","Integer"]}},
  startsWith:     {fn: strings.startsWith,       arity: {1: ["String"]}},
  endsWith:       {fn: strings.endsWith,         arity: {1: ["String"]}},
  contains:       {fn: strings.containsFn,       arity: {1: ["String"]}},
  replace:        {fn: strings.replace,          arity: {2: ["String", "String"]}},
  matches:        {fn: strings.matches,          arity: {1: ["String"]}},
  replaceMatches: {fn: strings.replaceMatches,   arity: {2: ["String", "String"]}},
  length:         {fn: strings.length },

  now:            {fn: datetime.now },
  today:          {fn: datetime.today },

  repeat:          {fn: filtering.repeatMacro, arity: {1: ["Expr"]}},
  children:        {fn: navigation.children },
  descendants:     {fn: navigation.descendants },

  "|":          {fn: combining.unionOp,   arity: {2: ["Any", "Any"]}},
  "=":          {fn: equality.equal,   arity: {2: ["Any", "Any"]}, nullable: true},
  "!=":         {fn: equality.unequal,   arity: {2: ["Any", "Any"]}, nullable: true},
  "~":          {fn: equality.equival,   arity: {2: ["Any", "Any"]}},
  "!~":         {fn: equality.unequival,   arity: {2: ["Any", "Any"]}},
  "<":          {fn: equality.lt,   arity: {2: ["Any", "Any"]}, nullable: true},
  ">":          {fn: equality.gt,   arity: {2: ["Any", "Any"]}, nullable: true},
  "<=":         {fn: equality.lte,  arity: {2: ["Any", "Any"]}, nullable: true},
  ">=":         {fn: equality.gte,  arity: {2: ["Any", "Any"]}, nullable: true},
  "&":          {fn: math.amp,     arity:  {2: ["String", "String"]}},
  "+":          {fn: math.plus,    arity:  {2: ["Number", "Number"]}, nullable: true},
  "-":          {fn: math.minus,   arity:  {2: ["Number", "Number"]}, nullable: true},
  "*":          {fn: math.mul,     arity:  {2: ["Number", "Number"]}, nullable: true},
  "/":          {fn: math.div,     arity:  {2: ["Number", "Number"]}, nullable: true},
  "mod":        {fn: math.mod,     arity:  {2: ["Number", "Number"]}, nullable: true},
  "div":        {fn: math.intdiv,  arity:  {2: ["Number", "Number"]}, nullable: true},
};

engine.InvocationExpression = function(ctx, parentData, node) {
  return node.children.reduce(function(acc, ch) {
    return engine.doEval(ctx, acc, ch);
  }, parentData);
};

engine.TermExpression = function(ctx, parentData, node) {
  return engine.doEval(ctx,parentData, node.children[0]);
};

engine.LiteralTerm = function(ctx, parentData, node) {
  var term = node.children[0];
  if(term){
    return engine.doEval(ctx, parentData, term);
  } else {
    return [node.text];
  }
};

engine.StringLiteral = function(ctx, parentData, node) {
  return [node.text.replace(/(^['"]|['"]$)/g, "")];
};

engine.BooleanLiteral = function(ctx, parentData, node) {
  if(node.text  === "true") {
    return [true];
  } else {
    return [false];
  }
};

engine.NumberLiteral = function(ctx, parentData, node) {
  return [Number(node.text)];
};

engine.Identifier = function(ctx, parentData, node) {
  return [node.text.replace(/(^"|"$)/g, "")];
};

engine.InvocationTerm = function(ctx, parentData, node) {
  return engine.doEval(ctx,parentData, node.children[0]);
};

engine.MemberInvocation = function(ctx, parentData ,node ) {
  const key = engine.doEval(ctx, parentData, node.children[0])[0];

  if (parentData) {
    if(util.isCapitalized(key)) {
      return parentData.filter(function(x) { return x.resourceType === key; });
    } else {
      return parentData.reduce(function(acc, res) {
        var toAdd = res[key];
        if(util.isSome(toAdd)) {
          if(Array.isArray(toAdd)) {
            // replace with array modification
            acc = acc.concat(toAdd);
          } else {
            acc.push(toAdd);
          }
          return acc;
        } else {
          return acc;
        }
      }, []);
    }
  } else {
    return [];
  }
};

engine.IndexerExpression = function(ctx, parentData, node) {
  const coll_node = node.children[0];
  const idx_node = node.children[1];
  var coll = engine.doEval(ctx, parentData, coll_node);
  var idx = engine.doEval(ctx, parentData, idx_node);

  if(util.isEmpty(idx)) {
    return [];
  }

  var idxNum = parseInt(idx[0]);
  if(coll && util.isSome(idxNum) && coll.length>idxNum && idxNum>=0) {
    return [coll[idxNum]];
  } else {
    return [];
  }
};

engine.Functn = function(ctx, parentData, node) {
  return node.children.map(function(x) {
    return engine.doEval(ctx, parentData, x);
  });
};

engine.realizeParams = function(ctx, parentData, args) {
  if(args && args[0] && args[0].children) {
    return args[0].children.map(function(x) {
      return engine.doEval(ctx, parentData, x);
    });
  } else {
    return [];
  }
};

const paramTable = {
  "Any": function(ctx, parentData, type, param){
    return engine.doEval(ctx, parentData, param);
  },
  "AnyAtRoot": function(ctx, parentData, type, param){
    return engine.doEval(ctx, ctx.dataRoot, param);
  },
  "Identifier": function(ctx, parentData, type, param){
    if(param.type == "TermExpression"){
      return param.text;
    } else {
      throw new Error("Expected identifier node, got ", JSON.stringify(param));
    }
  },
  "Integer": function(ctx, parentData, type, param){
    var res = engine.doEval(ctx, ctx.dataRoot, param);
    util.assertType(res[0], ["number"], "Number");
    return res[0];
  },
  "Number": function(ctx, parentData, type, param){
    var res = engine.doEval(ctx, ctx.dataRoot, param);
    // TODO: check type
    return res[0];
  },
  "String": function(ctx, parentData, type, param){
    var res = engine.doEval(ctx, ctx.dataRoot, param);
    // TODO: check type
    return res[0];
  },
  "Expr": function(ctx, parentData, type, param){
    return function(data) {
      return engine.doEval(ctx, util.arraify(data), param);
    };
  }
};

function makeParam(ctx, parentData, type, param) {
  var maker = paramTable[type];
  if(maker){
    // this is hack for $this
    ctx.currentData = parentData;
    return maker(ctx, parentData, type, param);
  } else {
    console.error(type, param);
    throw new Error("IMPL me for " + type);
  }
}

function doInvoke(ctx, fnName, data, rawParams){
  var invoc = engine.invocationTable[fnName];
  var res;
  if(invoc) {
    if(!invoc.arity){
      if(!rawParams){
        res = invoc.fn.call(ctx, util.arraify(data));
        return util.arraify(res);
      } else {
        throw new Error(fnName + " expects no params");
      }
    } else {
      var paramsNumber = rawParams ? rawParams.length : 0;
      var argTypes = invoc.arity[paramsNumber];
      if(argTypes){
        var params = [];
        for(var i = 0; i < paramsNumber; i++){
          var tp = argTypes[i];
          var pr = rawParams[i];
          params.push(makeParam(ctx, data, tp, pr));
        }
        params.unshift(data);
        if(invoc.nullable) {
          if(params.some(isNullable)){
            return [];
          }
        }
        res = invoc.fn.apply(ctx, params);
        return util.arraify(res);
      } else {
        console.log(fnName + " wrong arity: got " + paramsNumber );
        return [];
      }
    }
  } else {
    throw new Error("Not implemented: " + fnName);
  }
}
function isNullable(x) {
  var res = x=== null || x=== undefined || util.isEmpty(x);
  return res;
}

function infixInvoke(ctx, fnName, data, rawParams){
  var invoc = engine.invocationTable[fnName];
  if(invoc && invoc.fn) {
    var paramsNumber = rawParams ? rawParams.length : 0;
    if(paramsNumber != 2) { throw new Error("Infix invoke should have arity 2"); }
    var argTypes = invoc.arity[paramsNumber];
    if(argTypes){
      var params = [];
      for(var i = 0; i < paramsNumber; i++){
        var tp = argTypes[i];
        var pr = rawParams[i];
        params.push(makeParam(ctx, data, tp, pr));
      }
      if(invoc.nullable) {
        if(params.some(isNullable)){
          return [];
        }
      }
      var res = invoc.fn.apply(ctx, params);
      return util.arraify(res);
    } else {
      console.log(fnName + " wrong arity: got " + paramsNumber );
      return [];
    }
  } else {
    throw new Error("Not impl " + fnName);
  }
}

engine.FunctionInvocation = function(ctx, parentData, node) {
  var args = engine.doEval(ctx, parentData, node.children[0]);
  const fnName = args[0];
  args.shift();
  var rawParams = args && args[0] && args[0].children;
  return doInvoke(ctx, fnName, parentData, rawParams);
};

engine.ParamList = function(ctx, parentData, node) {
  // we do not eval param list because sometimes it should be passed as
  // lambda/macro (for example in case of where(...)
  return node;
};


engine.UnionExpression = function(ctx, parentData, node) {
  return infixInvoke(ctx, '|', parentData, node.children);
};

engine.ThisInvocation = function(ctx) {
  return util.arraify(ctx.currentData);
};

engine.EqualityExpression = function(ctx, parentData, node) {
  var op = node.terminalNodeText[0];
  return infixInvoke(ctx, op, parentData, node.children);
};

engine.InequalityExpression = function(ctx, parentData, node) {
  var op = node.terminalNodeText[0];
  return infixInvoke(ctx, op, parentData, node.children);
};

engine.AdditiveExpression = function(ctx, parentData, node) {
  var op = node.terminalNodeText[0];
  return infixInvoke(ctx, op, parentData, node.children);
};

engine.MultiplicativeExpression = function(ctx, parentData, node) {
  var op = node.terminalNodeText[0];
  return infixInvoke(ctx, op, parentData, node.children);
};


engine.evalTable = {
  BooleanLiteral: engine.BooleanLiteral,
  EqualityExpression: engine.EqualityExpression,
  FunctionInvocation: engine.FunctionInvocation,
  Functn: engine.Functn,
  Identifier: engine.Identifier,
  IndexerExpression: engine.IndexerExpression,
  InequalityExpression: engine.InequalityExpression,
  InvocationExpression: engine.InvocationExpression,
  AdditiveExpression: engine.AdditiveExpression,
  MultiplicativeExpression: engine.MultiplicativeExpression,
  InvocationTerm: engine.InvocationTerm,
  LiteralTerm: engine.LiteralTerm,
  MemberInvocation: engine.MemberInvocation,
  NumberLiteral: engine.NumberLiteral,
  ParamList: engine.ParamList,
  StringLiteral: engine.StringLiteral,
  TermExpression: engine.TermExpression,
  ThisInvocation: engine.ThisInvocation,
  UnionExpression: engine.UnionExpression,
};


engine.doEval = function(ctx, parentData, node) {
  const evaluator = engine.evalTable[node.type];
  if(evaluator){
    return evaluator.call(engine, ctx, parentData, node);
  } else {
    throw new Error("No " + node.type + " evaluator ");
  }
};

var parse = function(path) {
  return parser.parse(path);
};


/**
 *  Applies the given parsed FHIRPath expression to the given resource,
 *  returning the result of doEval.
 */
function applyParsedPath(resource, parsedPath) {
  let dataRoot = util.arraify(resource);
  return engine.doEval({dataRoot: dataRoot}, dataRoot, parsedPath.children[0]);
}

/**
 * @param {(object|object[])} resource -  FHIR resource, bundle as js object or array of resources
 * @param {string} path - fhirpath expression, sample 'Patient.name.given'
 */
var evaluate = function(resource, path) {
  const node = parser.parse(path);
  return applyParsedPath(resource, node);
};

/**
 *  Returns a function that takes a resource and returns the result of
 *  evaluating the given FHIRPath expression on that resource.  The advantage
 *  of this function over "evaluate" is that if you have multiple resources,
 *  the given FHIRPath expression will only be parsed once.
 * @param path the FHIRPath expression to be parsed.
 */
var compile = function(path) {
  const node = parse(path);
  return function(resource) {
    return applyParsedPath(resource, node);
  };
};

module.exports = {
  parse: parse,
  compile: compile,
  evaluate: evaluate
};
