# The fixtures are written by the TypeScript tests that produce them (packages/sr/test), so these
# tests check the server's real output against the R packages that have to read it.

fixture <- function(name) {
  path <- test_path("fixtures", name)
  if (!file.exists(path)) skip(paste("fixture", name, "not generated yet"))
  path
}

test_that("PRISMA counts fill the PRISMA2020 template and draw", {
  counts <- utils::read.csv(fixture("prisma_counts.csv"), stringsAsFactors = FALSE, colClasses = "character", na.strings = "")
  expect_equal(names(counts), c("data", "n"))
  expect_equal(counts$n[counts$data == "records_screened"], "4")
  expect_equal(counts$n[counts$data == "dbr_excluded"], "Wrong study design, 1")
  skip_if_not_installed("PRISMA2020")
  filled <- recueil:::sr_prisma_template(counts)
  expect_true(all(c("data", "n") %in% names(filled)))
  expect_equal(filled$n[filled$data == "database_results"], "6")
  data <- PRISMA2020::PRISMA_data(filled)
  expect_type(data, "list")
  plot <- PRISMA2020::PRISMA_flowdiagram(data, interactive = FALSE, previous = FALSE, other = TRUE)
  expect_false(is.null(plot))
})

test_that("risk-of-bias judgements read into robvis unmodified", {
  rob <- utils::read.csv(fixture("robvis_rob2.csv"), stringsAsFactors = FALSE, check.names = FALSE)
  expect_equal(names(rob), c("Study", "D1", "D2", "D3", "D4", "D5", "Overall", "Weight"))
  skip_if_not_installed("robvis")
  expect_s3_class(robvis::rob_summary(rob, tool = "ROB2"), "ggplot")
  expect_s3_class(robvis::rob_traffic_light(rob, tool = "ROB2"), "ggplot")
})

test_that("wide extraction data goes into metafor without reshaping", {
  wide <- utils::read.csv(fixture("extraction_wide.csv"), stringsAsFactors = FALSE, na.strings = "")
  expect_true(all(c("study", "group", "sr_events_treatment", "sr_n_treatment", "sr_events_control", "sr_n_control") %in% names(wide)))
  skip_if_not_installed("metafor")
  outcome <- wide[!is.na(wide$group) & startsWith(wide$group, "outcome:"), ]
  es <- metafor::escalc(measure = "RR", ai = sr_events_treatment, n1i = sr_n_treatment, ci = sr_events_control, n2i = sr_n_control, data = outcome)
  expect_equal(nrow(es), 1)
  expect_equal(as.numeric(es$yi), log((4 / 100) / (9 / 100)), tolerance = 1e-8)
})
