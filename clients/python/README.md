# recueil (Python)

The Python client of [Recueil](https://github.com/etabli-dev/etabli-recueil).

```python
from recueil import Client
rc = Client("https://recueil.example.org")   # token from RECUEIL_TOKEN
works = rc.table("works")                    # pandas DataFrame
g = rc.network("local")                      # networkx DiGraph of which library items cite which
rc.save_wos("savedrecs.txt")                 # Web of Science plain text: bibliometrix, biblioshiny, pybibx
rc.export_network("map.json", "co-citation", "vosviewer")
```

`pip install "recueil[pandas,networkx]"`. CONCEPT.md puts this package in its own repository
(`recueil-py`) for PyPI; it lives here until the API it calls is stable.
