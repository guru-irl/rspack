use std::{borrow::Cow, ops::Range};

#[cfg(feature = "plugin")]
pub mod runtime;

use rspack_intern::Atom;
use rustc_hash::{FxHashMap, FxHashSet};
use swc_next_ecma_ast::{
  Ast, BigIntLiteral, CommentKind as NextCommentKind, CommentPosition, Expr, ExprData,
  ExtraDataValue, IdentifierName, NumericLiteral, PrivateIdentifier, PropertyKey, PropertyKeyData,
  Span as NextAstSpan, StringLiteral, SubRange,
};

/// The resolved shape of a property key.
///
/// SWC Next 0.2.2+ collapsed `PropertyKeyData` into `IdentifierName | Expr`,
/// so literal keys are now nested inside `Expr`. This enum restores the
/// pre-0.2.2 shape for callers that matched the literal variants directly.
#[derive(Debug, Clone, Copy)]
pub enum PropertyKeyValue {
  IdentifierName(IdentifierName),
  StringLiteral(StringLiteral),
  NumericLiteral(NumericLiteral),
  BigIntLiteral(BigIntLiteral),
  PrivateIdentifier(PrivateIdentifier),
  OtherExpr(Expr),
}

pub fn classify_property_key(ast: &Ast<'_>, key: PropertyKey) -> PropertyKeyValue {
  match ast.property_key_data(key) {
    PropertyKeyData::IdentifierName(identifier) => PropertyKeyValue::IdentifierName(identifier),
    PropertyKeyData::Expr(expression) => match ast.expr_data(expression) {
      ExprData::StringLiteral(node) => PropertyKeyValue::StringLiteral(node),
      ExprData::NumericLiteral(node) => PropertyKeyValue::NumericLiteral(node),
      ExprData::BigIntLiteral(node) => PropertyKeyValue::BigIntLiteral(node),
      ExprData::PrivateIdentifier(node) => PropertyKeyValue::PrivateIdentifier(node),
      _ => PropertyKeyValue::OtherExpr(expression),
    },
  }
}

pub trait AstSubRangeExt {
  fn first<T>(&self, range: SubRange<T>) -> Option<T>
  where
    T: ExtraDataValue;

  fn second<T>(&self, range: SubRange<T>) -> Option<T>
  where
    T: ExtraDataValue;

  fn nodes<'a, T>(&'a self, range: SubRange<T>) -> impl DoubleEndedIterator<Item = T> + 'a
  where
    T: ExtraDataValue + 'a;
}

impl AstSubRangeExt for Ast<'_> {
  #[inline]
  fn first<T>(&self, range: SubRange<T>) -> Option<T>
  where
    T: ExtraDataValue,
  {
    range.get_node(self, 0)
  }

  #[inline]
  fn second<T>(&self, range: SubRange<T>) -> Option<T>
  where
    T: ExtraDataValue,
  {
    range.get_node(self, 1)
  }

  #[inline]
  fn nodes<'a, T>(&'a self, range: SubRange<T>) -> impl DoubleEndedIterator<Item = T> + 'a
  where
    T: ExtraDataValue + 'a,
  {
    range.iter().map(move |id| self.get_node_in_sub_range(id))
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RspackComment<'a> {
  pub span: NextAstSpan,
  pub kind: NextCommentKind,
  pub text: &'a str,
}

#[derive(Debug, Default)]
pub struct RspackComments<'a> {
  pub leading: FxHashMap<u32, Vec<RspackComment<'a>>>,
  pub trailing: FxHashMap<u32, Vec<RspackComment<'a>>>,
}

impl<'a> RspackComments<'a> {
  pub fn from_ast(ast: &'a Ast<'a>) -> Self {
    let source = ast.source();
    let mut comments = Self::default();
    for comment in ast.comments() {
      let value = ast.get_utf8(comment.value(source.as_bytes()));
      let item = RspackComment {
        span: comment.span,
        kind: comment.kind,
        text: value,
      };
      match comment.position {
        CommentPosition::Leading => comments
          .leading
          .entry(comment.attached_to)
          .or_default()
          .push(item),
        CommentPosition::Trailing => comments
          .trailing
          .entry(comment.attached_to)
          .or_default()
          .push(item),
      }
    }
    comments
  }

  pub fn has_flag(&self, pos: u32, flag: &str) -> bool {
    self.leading.get(&pos).is_some_and(|comment_list| {
      comment_list.iter().any(|comment| {
        comment.kind == NextCommentKind::Block
          && comment.text.lines().any(|line| {
            let line = line.trim_start_matches(['*', ' ']).trim();
            line.len() == flag.len() + 5
              && (line.starts_with("#__") || line.starts_with("@__"))
              && line.ends_with("__")
              && flag == &line[3..line.len() - 2]
          })
      })
    })
  }
}

fn adjacent_comments_before(
  ast: &Ast<'_>,
  error_span: NextAstSpan,
  pos: u32,
) -> Option<(Range<usize>, u32)> {
  let source = ast.source();
  let comments = ast.comments();
  let end = comments.partition_point(|comment| comment.span.end <= pos);
  let mut start = end;
  let mut cursor = pos as usize;

  while let Some(index) = start.checked_sub(1) {
    let comment = &comments[index];
    if comment.span.start < error_span.start || comment.span.end > error_span.end {
      break;
    }
    let Some(between) = source.get(comment.span.end as usize..cursor) else {
      break;
    };
    if !between
      .chars()
      .all(|c| c.is_whitespace() || c == '\u{feff}')
    {
      break;
    }
    cursor = comment.span.start as usize;
    start = index;
  }

  let prefix = source.get(error_span.start as usize..cursor)?;
  let previous_token_end = error_span.start
    + prefix
      .trim_end_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
      .len() as u32;
  if previous_token_end <= error_span.start
    || source.as_bytes().get(previous_token_end as usize - 1) != Some(&b'(')
  {
    return None;
  }
  Some((start..end, previous_token_end))
}

/// SWC Next attaches a block comment followed by a same-line `//` comment to
/// the preceding token as trailing trivia. The legacy parser made it leading
/// on the argument. Recover blocks attached to an opening parenthesis inside
/// the call, then merge them with the argument's existing leading comments.
/// Partial parentheses must not pull comments from the enclosing call.
pub fn get_swc_next_leading_comments<'a>(
  ast: &'a Ast<'a>,
  comments: &'a RspackComments<'a>,
  error_span: NextAstSpan,
  arg_start: u32,
) -> Cow<'a, [RspackComment<'a>]> {
  let leading = comments
    .leading
    .get(&arg_start)
    .map_or(&[][..], Vec::as_slice);
  let Some((range, previous_token_end)) = adjacent_comments_before(ast, error_span, arg_start)
  else {
    return Cow::Borrowed(leading);
  };

  // A parenthesized argument can have comments on either side of its opening
  // parenthesis. The call's own opening parenthesis is the outer boundary.
  let outer = adjacent_comments_before(ast, error_span, previous_token_end - 1);
  let source = ast.source();
  if source.as_bytes().get(arg_start as usize) == Some(&b'(') && outer.is_none() {
    return Cow::Borrowed(leading);
  }
  let mut recovered = Vec::new();
  for (range, token_end) in std::iter::once((range, previous_token_end)).chain(outer) {
    recovered.extend(
      ast.comments()[range]
        .iter()
        .filter(|comment| {
          comment.position == CommentPosition::Trailing
            && comment.kind == NextCommentKind::Block
            && comment.attached_to == token_end
        })
        .map(|comment| RspackComment {
          span: comment.span,
          kind: comment.kind,
          text: ast.get_utf8(comment.value(source.as_bytes())),
        }),
    );
  }
  if recovered.is_empty() {
    return Cow::Borrowed(leading);
  }
  recovered.extend_from_slice(leading);
  recovered.sort_unstable_by_key(|comment| (comment.span.start, comment.span.end));
  recovered.dedup_by_key(|comment| comment.span);
  Cow::Owned(recovered)
}

pub fn get_swc_next_comments<'a>(
  ast: &'a Ast<'a>,
  comments: &'a RspackComments<'a>,
  error_span: NextAstSpan,
  span: NextAstSpan,
) -> Vec<(bool, String)> {
  let mut result = vec![];
  let mut visited = FxHashSet::<NextAstSpan>::default();
  let leading = get_swc_next_leading_comments(ast, comments, error_span, span.start);

  for comment in leading
    .iter()
    .chain(comments.trailing.get(&span.end).into_iter().flatten())
  {
    if visited.insert(comment.span) {
      result.push((
        matches!(comment.kind, NextCommentKind::Line),
        comment.text.to_owned(),
      ));
    }
  }

  result
}

pub fn normalize_custom_filename(source: &str) -> &str {
  if source.starts_with('<') && source.ends_with('>') {
    &source[1..source.len() - 1] // remove '<' and '>' for swc FileName::Custom
  } else {
    source
  }
}

pub fn join_atom<'a, T: Iterator<Item = &'a Atom>>(mut iter: T, separator: &str) -> String {
  let mut ret = String::new();
  if let Some(item) = iter.next() {
    ret.push_str(item);
  }
  for item in iter {
    ret.push_str(separator);
    ret.push_str(item);
  }
  ret
}

#[test]
fn test_normalize_custom_filename() {
  let input = "<custom_filename>";
  let expected_output = "custom_filename";
  assert_eq!(normalize_custom_filename(input), expected_output);
}
