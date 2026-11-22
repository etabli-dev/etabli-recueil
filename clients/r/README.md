# recueil (R)

The R client of [Recueil](https://github.com/etabli-dev/etabli-recueil): the library as data frames,
the citation graph as `tidygraph`/`igraph`, and the library as a **bibliometrix** `M` data frame.

```r
library(recueil)
con <- rc_connect("https://recueil.example.org")   # token from RECUEIL_TOKEN
M <- rc_bibliometrix(con)                           # bibliometrix::convert2df under the hood
results <- bibliometrix::biblioAnalysis(M)
g <- rc_network(con, "local")                       # which library items cite which
rc_coverage(con)                                    # report this beside any map
rc_export_network(con, "map.json", "co-citation", "vosviewer")
```

The same Web of Science file (`GET /api/v1/analytics/wos.txt`) loads in **biblioshiny** as it is.
CONCEPT.md puts this package in its own repository (`recueil-r`) for CRAN; it lives here until the
API it calls is stable.
