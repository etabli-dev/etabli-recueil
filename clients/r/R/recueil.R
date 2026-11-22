#' Connect to a Recueil server
#'
#' @param url Base URL of the server, e.g. `"https://recueil.example.org"`. Defaults to the
#'   `RECUEIL_URL` environment variable.
#' @param token A scoped API token (`analytics:read` and `items:read` are enough to read). Defaults
#'   to `RECUEIL_TOKEN`; never put a token in a script.
#' @return A `recueil_connection`.
#' @export
rc_connect <- function(url = Sys.getenv("RECUEIL_URL"), token = Sys.getenv("RECUEIL_TOKEN")) {
  if (!nzchar(url)) stop("no server: pass `url` or set RECUEIL_URL", call. = FALSE)
  structure(list(url = sub("/+$", "", url), token = if (nzchar(token)) token else NULL), class = "recueil_connection")
}

#' @export
print.recueil_connection <- function(x, ...) {
  cat("<recueil_connection>", x$url, if (is.null(x$token)) "(no token)" else "(token set)", "\n")
  invisible(x)
}

rc_request <- function(con, path, query = list()) {
  req <- httr2::request(paste0(con$url, "/api/v1", path))
  req <- httr2::req_url_query(req, !!!query)
  req <- httr2::req_user_agent(req, "recueil R client")
  if (!is.null(con$token)) req <- httr2::req_auth_bearer_token(req, con$token)
  httr2::req_perform(req)
}

rc_text <- function(con, path, query = list()) httr2::resp_body_string(rc_request(con, path, query))

rc_json <- function(con, path, query = list()) jsonlite::fromJSON(rc_text(con, path, query), simplifyVector = TRUE)

#' Items, as a data frame
#'
#' @param con A connection from [rc_connect()].
#' @param q Optional full-text query.
#' @param limit Upper bound on the number of items fetched.
#' @export
rc_items <- function(con, q = NULL, limit = 10000) {
  rows <- list()
  cursor <- NULL
  repeat {
    query <- list(limit = min(200, limit - length(rows)))
    if (!is.null(q)) query$q <- q
    if (!is.null(cursor)) query$cursor <- cursor
    page <- jsonlite::fromJSON(rc_text(con, "/items", query), simplifyVector = FALSE)
    rows <- c(rows, page$data)
    cursor <- page$page$nextCursor
    if (is.null(cursor) || length(rows) >= limit) break
  }
  if (length(rows) == 0) return(data.frame())
  flat <- lapply(rows, function(row) {
    keep <- row[vapply(row, function(v) is.atomic(v) && length(v) <= 1, logical(1))]
    as.data.frame(lapply(keep, function(v) if (is.null(v)) NA else v), stringsAsFactors = FALSE)
  })
  do.call(rbind, lapply(flat, function(df) df[, intersect(names(flat[[1]]), names(df)), drop = FALSE]))
}

#' One analytics table
#'
#' @param con A connection from [rc_connect()].
#' @param table One of `"works"`, `"creators"`, `"works_creators"`, `"terms"`, `"works_terms"`,
#'   `"edges"`, `"metrics"`.
#' @export
rc_table <- function(con, table = c("works", "creators", "works_creators", "terms", "works_terms", "edges", "metrics")) {
  table <- match.arg(table)
  utils::read.csv(text = rc_text(con, paste0("/analytics/tables/", table, ".csv")), stringsAsFactors = FALSE, na.strings = "")
}

#' The library as a bibliometrix data frame
#'
#' Downloads the library (or a collection, or the result of a query) as Web of Science plain text
#' and converts it with [bibliometrix::convert2df()], so every bibliometrix function — and
#' biblioshiny, given the same file — works on it unchanged.
#'
#' @param con A connection from [rc_connect()].
#' @param collection Optional collection or saved-search id.
#' @param q Optional full-text query.
#' @param file Where to keep the plain-text file; a temporary file by default.
#' @return The bibliometrix `M` data frame.
#' @export
rc_bibliometrix <- function(con, collection = NULL, q = NULL, file = tempfile(fileext = ".txt")) {
  if (!requireNamespace("bibliometrix", quietly = TRUE)) stop("install the 'bibliometrix' package", call. = FALSE)
  query <- list()
  if (!is.null(collection)) query$collectionId <- collection
  if (!is.null(q)) query$q <- q
  writeLines(rc_text(con, "/analytics/wos.txt", query), file, useBytes = TRUE)
  bibliometrix::convert2df(file, dbsource = "wos", format = "plaintext")
}

network_from_json <- function(json, as = c("tidygraph", "igraph", "list")) {
  as <- match.arg(as)
  net <- if (is.character(json)) jsonlite::fromJSON(json, simplifyVector = TRUE) else json
  nodes <- as.data.frame(net$nodes, stringsAsFactors = FALSE)
  edges <- as.data.frame(net$edges, stringsAsFactors = FALSE)
  if (as == "list") return(list(nodes = nodes, edges = edges))
  names(nodes)[names(nodes) == "id"] <- "name"
  names(edges)[names(edges) == "source"] <- "from"
  names(edges)[names(edges) == "target"] <- "to"
  directed <- nrow(edges) == 0 || all(edges$directed)
  if (as == "igraph") {
    if (!requireNamespace("igraph", quietly = TRUE)) stop("install the 'igraph' package", call. = FALSE)
    return(igraph::graph_from_data_frame(edges, directed = directed, vertices = nodes))
  }
  if (!requireNamespace("tidygraph", quietly = TRUE)) stop("install the 'tidygraph' package", call. = FALSE)
  tidygraph::tbl_graph(nodes = nodes, edges = edges, directed = directed, node_key = "name")
}

#' A network from the citation graph
#'
#' @param con A connection from [rc_connect()].
#' @param network `"citations"`, `"local"` (only citations between library items),
#'   `"co-citation"` or `"coupling"` (from the latest `recueil graph derive`).
#' @param as `"tidygraph"` (default), `"igraph"` or `"list"`.
#' @export
rc_network <- function(con, network = c("citations", "local", "co-citation", "coupling"), as = c("tidygraph", "igraph", "list")) {
  network <- match.arg(network)
  network_from_json(rc_text(con, "/graph/network", list(network = network, format = "json")), as = match.arg(as))
}

#' Reference-data coverage
#'
#' How many items have reference data, from which sources and when — the figure to report beside
#' any map built from this library.
#' @param con A connection from [rc_connect()].
#' @export
rc_coverage <- function(con) rc_json(con, "/graph/coverage")

#' The most-cited works not in the library
#' @param con A connection from [rc_connect()].
#' @param limit How many.
#' @export
rc_top_cited <- function(con, limit = 50) rc_json(con, "/graph/shadow-works", list(limit = limit))$data

#' Save a network for VOSviewer, Gephi or igraph
#'
#' @param con A connection from [rc_connect()].
#' @param path The file to write.
#' @param network As in [rc_network()].
#' @param format `"vosviewer"` (JSON), `"gexf"` (Gephi) or `"graphml"`.
#' @export
rc_export_network <- function(con, path, network = c("citations", "local", "co-citation", "coupling"), format = c("vosviewer", "gexf", "graphml")) {
  writeLines(rc_text(con, "/graph/network", list(network = match.arg(network), format = match.arg(format))), path, useBytes = TRUE)
  invisible(path)
}

#' A curated network as a tidygraph, with its layout
#'
#' The publication route of ADR-0013: arrange the figure in Recueil, then render it with ggraph
#' using the saved positions, e.g. `ggraph::ggraph(g, layout = "manual", x = x, y = -y)`.
#'
#' @param con A connection from [rc_connect()].
#' @param id The curated network id.
#' @param version A version number; the head by default. Frozen versions are reproducible.
#' @export
rc_curated <- function(con, id, version = NULL) {
  query <- list(format = "json")
  if (!is.null(version)) query$version <- version
  net <- jsonlite::fromJSON(rc_text(con, paste0("/curated-networks/", id, "/export"), query), simplifyVector = TRUE)
  positions <- net$positions
  nodes <- as.data.frame(net$nodes, stringsAsFactors = FALSE)
  nodes$x <- vapply(nodes$id, function(n) positions[[n]]$x, numeric(1))
  nodes$y <- vapply(nodes$id, function(n) positions[[n]]$y, numeric(1))
  net$nodes <- nodes
  net$positions <- NULL
  network_from_json(net)
}
