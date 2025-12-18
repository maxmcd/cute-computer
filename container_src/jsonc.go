package main

import "bytes"

const (
	_hasCommentRunes byte = 1 << iota
	_isString
	_isCommentLine
	_isCommentBlock
	_checkNext
)

func sanitizeJSONC(data []byte) []byte {
	var state byte
	return bytes.Map(func(r rune) rune {
		checkNext := state&_checkNext != 0
		state &^= _checkNext
		switch r {
		case '\n':
			state &^= _isCommentLine
		case '\\':
			if state&_isString != 0 {
				state |= _checkNext
			}
		case '"':
			if state&_isString != 0 {
				if checkNext { // escaped quote
					break // switch => write rune
				}
				state &^= _isString
			} else if state&(_isCommentLine|_isCommentBlock) == 0 {
				state |= _isString
			}
		case '/':
			if state&_isString != 0 {
				break // switch => write rune
			}
			if state&_isCommentBlock != 0 {
				if checkNext {
					state &^= _isCommentBlock
				} else {
					state |= _isCommentLine
				}
			} else {
				if checkNext {
					state |= _isCommentLine
				} else {
					state |= _checkNext
				}
			}
			return -1 // mark rune for skip
		case '*':
			if state&_isString != 0 {
				break // switch => write rune
			}
			if checkNext {
				state |= _isCommentBlock
			} else if state&_isCommentBlock != 0 {
				state |= _checkNext
			}
			return -1 // mark rune for skip
		}
		if state&(_isCommentLine|_isCommentBlock) != 0 {
			return -1 // mark rune for skip
		}
		return r
	}, data)
}
