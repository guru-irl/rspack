def need($ok; $why): if $ok then . else error($why) end;
def key: .scenario + ":" + .id;
def edits($xs): [$xs[] | select(.type == "row" and .id != "INIT")];
def receipt($xs; $hash; $name):
  [$xs[] | select(.type == "identity")] as $identity
  | [$xs[] | select(.type == "summary")] as $summary
  | edits($xs) as $rows
  | need(($hash | test("^[0-9a-f]{64}$")); $name + ": invalid expected hash")
  | need(($identity | length) == 1 and $identity[0].sha == $hash
         and $identity[0].mode == "native"; $name + ": wrong identity")
  | need(($summary | length) == 1 and $summary[0].rows == ($rows | length)
         and $summary[0].passed == ([$rows[] | select(.ok == true)] | length);
         $name + ": incomplete summary")
  | need(($rows | map(key) | sort) == ($keys | sort);
         $name + ": missing, duplicate or unexpected row")
  | $rows;
def delivered:
  .ok == true and (.newErrors | length) == 0
  and (if .kind == "rebuild" then
         .noticed == true and (.who | type) == "string" and (.who | length) > 0
         and (. as $r | all(($r.who | split("+"))[]; $r.perCompiler[.] > 0))
       elif .kind == "quiet" then .noticed == false
       else true end);
need(($keys | length) > 0 and ($keys | length) == ($keys | unique | length);
     "empty or duplicate manifest")
| receipt($cand; $cHash; "candidate") as $c
| receipt($main; $mHash; "main") as $m
| need(any($m[]; .kind == "rebuild" and .ok == true); "no main-passing edit")
| [ $m[] as $mr | $c[] | select(key == ($mr | key))
    | select(.kind != $mr.kind or .who != $mr.who
             or ($mr.ok == true and (delivered | not)))
    | key ] as $bad
| need(($bad | length) == 0; "main floor violated: " + ($bad | join(", ")))
| {rows: ($c | length), main_passing: ([$m[] | select(.ok == true)] | length), bad: $bad}
