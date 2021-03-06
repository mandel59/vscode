/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { isFalsyOrEmpty } from 'vs/base/common/arrays';
import { indexOfIgnoreCase } from 'vs/base/common/strings';
import { IMatch, fuzzyContiguousFilter } from 'vs/base/common/filters';
import { ISuggestSupport } from 'vs/editor/common/modes';
import { ISuggestionItem } from './suggest';

export interface ICompletionItem extends ISuggestionItem {
	highlights?: IMatch[];
}

export interface ICompletionStats {
	suggestionCount: number;
	snippetCount: number;
	textCount: number;
	[name: string]: any;
}

export class LineContext {
	leadingLineContent: string;
	characterCountDelta: number;
}

export class CompletionModel {

	private _lineContext: LineContext;
	private _column: number;
	private _items: ICompletionItem[];

	private _filteredItems: ICompletionItem[];
	private _topScoreIdx: number;
	private _incomplete: ISuggestSupport[];
	private _stats: ICompletionStats;

	constructor(items: ISuggestionItem[], column: number, lineContext: LineContext) {
		this._items = items;
		this._column = column;
		this._lineContext = lineContext;
	}

	replaceIncomplete(newItems: ISuggestionItem[], compareFn: (a: ISuggestionItem, b: ISuggestionItem) => number): void {
		let newItemsIdx = 0;
		for (let i = 0; i < this._items.length; i++) {
			if (this._incomplete.indexOf(this._items[i].support) >= 0) {
				// we found an item which support signaled 'incomplete'
				// which means we remove the item. For perf reasons we
				// frist replace and only then splice.
				if (newItemsIdx < newItems.length) {
					this._items[i] = newItems[newItemsIdx++];
				} else {
					this._items.splice(i, 1);
					i--;
				}
			}
		}
		// add remaining new items
		if (newItemsIdx < newItems.length) {
			this._items.push(...newItems.slice(newItemsIdx));
		}

		// sort and reset cached state
		this._items.sort(compareFn);
		this._filteredItems = undefined;
	}

	get lineContext(): LineContext {
		return this._lineContext;
	}

	set lineContext(value: LineContext) {
		if (this._lineContext.leadingLineContent !== value.leadingLineContent
			|| this._lineContext.characterCountDelta !== value.characterCountDelta) {

			this._lineContext = value;
			this._filteredItems = undefined;
		}
	}

	get items(): ICompletionItem[] {
		this._ensureCachedState();
		return this._filteredItems;
	}

	get topScoreIdx(): number {
		this._ensureCachedState();
		return this._topScoreIdx;
	}

	get incomplete(): ISuggestSupport[] {
		this._ensureCachedState();
		return this._incomplete;
	}

	get stats(): ICompletionStats {
		this._ensureCachedState();
		return this._stats;
	}

	private _ensureCachedState(): void {
		if (!this._filteredItems) {
			this._createCachedState();
		}
	}

	private _createCachedState(): void {
		this._filteredItems = [];
		this._incomplete = [];
		this._topScoreIdx = -1;
		this._stats = { suggestionCount: 0, snippetCount: 0, textCount: 0 };

		const {leadingLineContent, characterCountDelta} = this._lineContext;
		let word = '';
		let topScore = -1;

		for (const item of this._items) {

			const {suggestion, support, container} = item;
			const filter = support && support.filter || fuzzyContiguousFilter;

			// 'word' is that remainder of the current line that we
			// filter and score against. In theory each suggestion uses a
			// differnet word, but in practice not - that's why we cache
			const wordLen = suggestion.overwriteBefore + characterCountDelta - (item.position.column - this._column);
			if (word.length !== wordLen) {
				word = leadingLineContent.slice(-wordLen);
			}

			let match = false;

			// compute highlights based on 'label'
			item.highlights = filter(word, suggestion.label);
			match = item.highlights !== null;

			// no match on label nor codeSnippet -> check on filterText
			if (!match && typeof suggestion.filterText === 'string') {
				if (!isFalsyOrEmpty(filter(word, suggestion.filterText))) {
					match = true;

					// try to compute highlights by stripping none-word
					// characters from the end of the string
					item.highlights = filter(word.replace(/^\W+|\W+$/, ''), suggestion.label);
				}
			}

			if (!match) {
				continue;
			}

			this._filteredItems.push(item);

			// compute score against word
			const score = CompletionModel._scoreByHighlight(item, word, word.toLowerCase());
			if (score > topScore) {
				topScore = score;
				this._topScoreIdx = this._filteredItems.length - 1;
			}

			// collect those supports that signaled having
			// an incomplete result
			if (container.incomplete && this._incomplete.indexOf(support) < 0) {
				this._incomplete.push(support);
			}

			// update stats
			this._stats.suggestionCount++;
			switch (suggestion.type) {
				case 'snippet': this._stats.snippetCount++; break;
				case 'text': this._stats.textCount++; break;
			}
		}
	}

	private static _base = 100;

	private static _scoreByHighlight(item: ICompletionItem, currentWord: string, BLA): number {
		const {highlights, suggestion} = item;

		if (isFalsyOrEmpty(highlights)) {
			return 0;
		}

		let caseSensitiveMatches = 0;
		let caseInsensitiveMatches = 0;
		let firstMatchStart = 0;
		let notMatching = 0;

		const len = Math.min(CompletionModel._base, suggestion.label.length);
		let currentWordOffset = 0;

		for (let pos = 0, idx = 0; pos < len; pos++) {

			const highlight = highlights[idx];

			if (pos < highlight.start) {
				// not covered by a highlight
				notMatching += 1;

			} else if (pos === highlight.start) {
				// reached a highlight: find highlighted part
				// and count case-sensitive /case-insensitive matches
				const part = suggestion.label.substring(highlight.start, highlight.end);
				currentWordOffset = indexOfIgnoreCase(currentWord, part, currentWordOffset);
				if (currentWordOffset >= 0) {
					do {
						if (suggestion.label[pos] === currentWord[currentWordOffset]) {
							caseSensitiveMatches += 1;
						} else {
							caseInsensitiveMatches += 1;
						}
						pos += 1;
						currentWordOffset += 1;
					} while (pos < highlight.end);
				}

				// proceed with next highlight, store first start,
				// exit loop when no highlight is available
				if (idx === 0) {
					firstMatchStart = highlight.start;
				}
				idx += 1;
				if (idx >= highlights.length) {
					notMatching += len - pos;
					break;
				}
			}
		}

		// combine the five scoring values into one
		// value using base_100. Values further left
		// are more important
		return (CompletionModel._base ** 4) * caseSensitiveMatches
			+ (CompletionModel._base ** 3) * caseInsensitiveMatches
			+ (CompletionModel._base ** 2) * (CompletionModel._base - firstMatchStart)
			+ (CompletionModel._base ** 1) * (CompletionModel._base - highlights.length)
			+ (CompletionModel._base ** 0) * (CompletionModel._base - notMatching);
	}
}
