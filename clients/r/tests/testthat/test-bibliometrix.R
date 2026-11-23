test_that("the Web of Science export converts with bibliometrix, unmodified", {
  skip_if_not_installed("bibliometrix")
  file <- test_path("fixtures", "savedrecs.txt")
  M <- bibliometrix::convert2df(file, dbsource = "wos", format = "plaintext")
  expect_equal(nrow(M), 2)
  expect_true(all(c("AU", "TI", "SO", "PY", "CR", "DI", "TC") %in% names(M)))
  expect_equal(M$PY[order(M$PY)], c(2019, 2020))
  expect_match(M$CR[M$PY == 2020], "BABBAGE C, 1999, BONE")
  results <- bibliometrix::biblioAnalysis(M)
  expect_s3_class(results, "bibliometrix")
})

test_that("a network becomes a tidygraph or an igraph", {
  json <- '{"nodes":[{"id":"n1","label":"A","type":"item","year":2020,"venue":null,"doi":"10.1/a","citedBy":3,"inLibrary":true},{"id":"n2","label":"B","type":"shadow_work","year":1999,"venue":null,"doi":null,"citedBy":null,"inLibrary":false}],"edges":[{"source":"n1","target":"n2","type":"cites","directed":true,"weight":1,"provenance":"crossref"}],"generatedAt":"2026-11-22T00:00:00Z","description":"citations"}'
  as_list <- recueil:::network_from_json(json, as = "list")
  expect_equal(nrow(as_list$nodes), 2)
  skip_if_not_installed("igraph")
  g <- recueil:::network_from_json(json, as = "igraph")
  expect_equal(igraph::vcount(g), 2)
  expect_true(igraph::is_directed(g))
  skip_if_not_installed("tidygraph")
  expect_s3_class(recueil:::network_from_json(json), "tbl_graph")
})

test_that("a connection needs a server and never prints the token", {
  expect_error(rc_connect(url = ""), "no server")
  out <- capture.output(print(rc_connect("https://example.org/", token = "secret")))
  expect_false(any(grepl("secret", out)))
})
