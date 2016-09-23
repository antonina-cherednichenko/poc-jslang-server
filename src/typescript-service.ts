/// <reference path="../typings/node/node.d.ts"/>
///// <reference path="../typings/typescript/typescript.d.ts"/>

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Position } from 'vscode-languageserver';

import * as util from './util';
import VersionedLanguageServiceHost from './language-service-host';

import ExportedSymbolsProvider from './exported-symbols-provider'
import ExternalRefsProvider from './external-refs-provider';
import WorkspaceSymbolsProvider from './workspace-symbols-provider';

var sanitizeHtml = require('sanitize-html');
var JSONPath = require('jsonpath-plus');

const pathDelimiter = "$";

export default class TypeScriptService {
    services: ts.LanguageService;
    root: string;
    externalRefs = null;
    exportedEnts = null;
    topLevelDecls = null;
    exportedSymbolProvider: ExportedSymbolsProvider;
    externalRefsProvider: ExternalRefsProvider;
    workspaceSymbolProvider: WorkspaceSymbolsProvider;

    host: VersionedLanguageServiceHost;

    envDefs = [];

    constructor(root: string, strict: boolean) {
        this.root = root;
        this.host = new VersionedLanguageServiceHost(root, strict);

        // Create the language service files
        this.services = ts.createLanguageService(this.host, ts.createDocumentRegistry());
        this.initEnvDefFiles();

        //initialize providers 
        this.exportedSymbolProvider = new ExportedSymbolsProvider(this);
        this.externalRefsProvider = new ExternalRefsProvider(this);
        this.workspaceSymbolProvider = new WorkspaceSymbolsProvider(this);
    }

    addFile(name, content: string) {
        this.host.addFile(name, content);
    }

    removeFile(name: string) {
        this.host.removeFile(name);
    }

    initEnvDefFiles() {
        try {
            this.envDefs.push(JSON.parse(fs.readFileSync(path.join(__dirname, '../src/defs/node.json'), 'utf8')));
            this.envDefs.push(JSON.parse(fs.readFileSync(path.join(__dirname, '../src/defs/ecmascript.json'), 'utf8')));
        } catch (error) {
            console.error("error = ", error);
        }
    }

    lookupEnvDef(property, container) {
        let results = [];
        if (this.envDefs && this.envDefs.length > 0) {
            this.envDefs.forEach(envDef => {
                let res = JSONPath({ json: envDef, path: `$..${property}` });
                if (res) {
                    results = results.concat(res);
                }
            });
        }

        if (results.length > 1) {
            let result = results.find(info => {
                if (info['!url'] && container && info['!url'].indexOf(container) > -1) {
                    return true;
                }
            });
            return result ? result : results[0];
        }

        if (results) {
            return results[0];
        }
    }

    getPathForPosition(uri: string, line: number, column: number): string[] {
        const fileName: string = util.uri2path(uri);
        if (!this.host.hasFile(fileName)) {
            return [];
        }

        const offset: number = ts.getPositionOfLineAndCharacter(this.services.getProgram().getSourceFile(fileName), line, column);
        let defs = this.services.getDefinitionAtPosition(fileName, offset);
        let paths = [];

        if (defs) {
            defs.forEach(def => {
                let pathRes = def.fileName;
                if (def.name && def.containerName) {
                    pathRes = `${pathRes}${pathDelimiter}${def.containerName}${pathDelimiter}${def.name}`
                } else {
                    let sourceFile = this.services.getProgram().getSourceFile(def.fileName);
                    let foundNode = (ts as any).getTouchingToken(sourceFile, def.textSpan.start);
                    let allParents = util.collectAllParents(foundNode, []).filter(parent => {
                        return util.isNamedDeclaration(parent);
                    });

                    allParents.forEach(parent => {
                        pathRes = `${pathRes}${pathDelimiter}${parent.name.text}`
                    });
                    if (util.isNamedDeclaration(foundNode)) {
                        pathRes = `${pathRes}${pathDelimiter}${foundNode.name.text}`
                    }
                }

                paths.push(pathRes);
            });
        } else {
            let sourceFile = this.services.getProgram().getSourceFile(fileName);
            let foundNode = (ts as any).getTouchingToken(sourceFile, offset);
            let allParents = util.collectAllParents(foundNode, []).filter(parent => {
                return util.isNamedDeclaration(parent);
            });
            let pathRes = fileName;
            allParents.forEach(parent => {
                pathRes = `${pathRes}${pathDelimiter}${parent.name.text}`
            });
            if (util.isNamedDeclaration(foundNode)) {
                pathRes = `${pathRes}${pathDelimiter}${foundNode.name.text}`
            }
            paths.push(pathRes);
        }
        return paths;
    }

    getPositionForPath(path: string) {
        let resNodes = [];
        function traverseNodeChain(node, parts) {
            if (!node) {
                return;
            }

            node.getChildren().forEach(child => {
                if (util.isNamedDeclaration(child)) {
                    let name = <ts.Identifier>child.name.text;
                    let partName = parts[0];
                    if (name == partName) {
                        let restParts = parts.slice(1);
                        if (restParts.length == 0) {
                            resNodes.push(child);
                            return;
                        } else {
                            traverseNodeChain(child, restParts);
                        }
                    }
                } else {
                    traverseNodeChain(child, parts);
                }
            });
        }

        var parts = path.split(pathDelimiter);
        let fileName = parts[0];
        let sourceFile = this.services.getProgram().getSourceFile(fileName);
        traverseNodeChain(sourceFile, parts.slice(1));
        let res = [];
        if (resNodes.length > 0) {
            resNodes.forEach(resNode => {
                let file: ts.SourceFile = resNode.getSourceFile();
                let posStart = resNode.getStart(file);
                let posEnd = resNode.getEnd();
                res.push({ fileName: file.fileName, start: posStart, end: posEnd });
            });
        }
        return res;
    }

    getExternalRefs() {
        if (this.externalRefs === null) {
            this.externalRefs = this.externalRefsProvider.collectExternals();
        }
        return this.externalRefs;
    }

    getExportedEnts() {
        if (this.exportedEnts === null) {
            this.exportedEnts = this.exportedSymbolProvider.collectExportedEntities();
        }
        return this.exportedEnts;
    }

    doc(node: ts.Node): string {
        let text = node.getSourceFile().getFullText();
        let comments1 = (ts as any).getLeadingCommentRanges(text, node.getFullStart());
        let comments2 = (ts as any).getTrailingCommentRanges(text, node.getEnd());
        let comments = [];
        if (!comments1 && !comments2) {
            let parents = util.collectAllParents(node, []);
            for (let i = 0; i < parents.length; i++) {
                let parent = parents[i];
                let comments1 = (ts as any).getLeadingCommentRanges(text, parent.getFullStart());
                let comments2 = (ts as any).getTrailingCommentRanges(text, parent.getEnd());
                if (comments1) {
                    comments = comments.concat(comments1);
                }
                if (comments2) {
                    comments = comments.concat(comments2);
                }
                if (comments1 || comments2) break;
            }
        } else {
            comments = comments1 || comments2;
        }

        let res = "";
        if (comments) {
            comments.forEach(comment => {
                res = res + sanitizeHtml(`<p>${text.substring(comment.pos + 2, comment.end)}</p>`);
            });
        }
        return res;
    }

    getDefinition(uri: string, line: number, column: number): ts.DefinitionInfo[] {
        try {
            const fileName: string = util.uri2path(uri);
            if (!this.host.hasFile(fileName)) {
                return [];
            }

            const offset: number = ts.getPositionOfLineAndCharacter(this.services.getProgram().getSourceFile(fileName), line, column);
            return this.services.getDefinitionAtPosition(fileName, offset);
            // if (defs) {
            //     defs.forEach(def => {
            //         let fileName = def.fileName;
            //         let name = def.name;
            //         let container = def.containerName.toLowerCase();
            //         if (fileName.indexOf("merged.lib.d.ts") > -1) {
            //             let result = this.lookupEnvDef(name, container);
            //             if (result) {
            //                 def['url'] = result['!url'];
            //             }
            //         }
            //     });
            // }
            // return defs;
        } catch (exc) {
            console.error("Exception occcurred = ", exc);
        }
    }

    getExternalDefinition(uri: string, line: number, column: number) {
        const fileName: string = util.uri2path(uri);
        if (!this.host.hasFile(fileName)) {
            return;
        }

        const offset: number = ts.getPositionOfLineAndCharacter(this.services.getProgram().getSourceFile(fileName), line, column);
        return this.getExternalRefs().find(ref => {
            if (ref.file == fileName && ref.pos == offset) {
                return true;
            }
        });
    }

    getTopLevelDeclarations() {
        if (this.topLevelDecls === null) {
            this.topLevelDecls = this.workspaceSymbolProvider.collectTopLevelInterface();
        }
        return this.topLevelDecls;

    }


    getHover(uri: string, line: number, column: number): ts.QuickInfo {
        try {
            const fileName: string = util.uri2path(uri);
            if (!this.host.hasFile(fileName)) {
                return null;
            }

            const offset: number = ts.getPositionOfLineAndCharacter(this.services.getProgram().getSourceFile(fileName), line, column);
            return this.services.getQuickInfoAtPosition(fileName, offset);
        } catch (exc) {
            console.error("Exception occcurred = ", exc);
        }
    }

    getReferences(uri: string, line: number, column: number): ts.ReferenceEntry[] {
        try {
            const fileName: string = util.uri2path(uri);
            if (!this.host.hasFile(fileName)) {
                return null;
            }

            const offset: number = ts.getPositionOfLineAndCharacter(this.services.getProgram().getSourceFile(fileName), line, column);
            // const offset: number = this.offset(fileName, line, column);
            return this.services.getReferencesAtPosition(fileName, offset);
        } catch (exc) {
            console.error("Exception occcurred = ", exc);
        }
    }

    getPositionFromOffset(fileName: string, offset: number): Position {
        let res = ts.getLineAndCharacterOfPosition(this.services.getProgram().getSourceFile(fileName), offset);
        return Position.create(res.line, res.character);
    }


    private resolvePath(p: string): string {
        return path.resolve(this.root, p);
    }
}
